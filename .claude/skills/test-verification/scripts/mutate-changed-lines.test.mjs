import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { actionableMutants, chooseTargets, DATA_MUTATORS, MAX_CHANGED_LINES, MAX_FEEDBACK_MUTANTS, mutationFeedback, summarizeMutationReport, toRanges } from './lib/mutation.mjs';
import { gateFeedback, MAX_MUTATION_ROUNDS, nextRepair } from './lib/repair-round.mjs';
import { MUTATION_TIMEOUT_MS, runMutation, strykerConfig } from './mutate-changed-lines.mjs';

const location = (line, startColumn = 1, endColumn = 2) => ({ start: { line, column: startColumn }, end: { line, column: endColumn } });
const mutant = (overrides = {}) => ({ path: 'backend/src/a.ts', line: 1, status: 'Survived', mutator: 'ConditionalExpression', original: 'a', replacement: 'b', data_only: false, ...overrides });

describe('toRanges', () => {
  it('joins neighboring lines and keeps gaps', () => {
    assert.deepEqual(toRanges([7, 1, 2, 3, 5]), [[1, 3], [5, 5], [7, 7]]);
  });

  it('counts a repeated line once', () => {
    assert.deepEqual(toRanges([2, 2, 3]), [[2, 3]]);
  });

  it('gives nothing for no lines', () => {
    assert.deepEqual(toRanges([]), []);
  });
});

describe('chooseTargets', () => {
  it('groups by package, with ranges relative to the package', () => {
    const changed = new Map([['backend/src/a.ts', [1, 2, 9]], ['frontend/src/b.tsx', [4]]]);
    const { targets, changed_lines: count } = chooseTargets(['backend/src/a.ts', 'frontend/src/b.tsx'], changed);
    assert.deepEqual(targets, { backend: ['src/a.ts:1-2', 'src/a.ts:9-9'], frontend: ['src/b.tsx:4-4'] });
    assert.equal(count, 4);
  });

  it('mutates whole files when there is no diff to limit it', () => {
    const { targets, changed_lines: count } = chooseTargets(['backend/src/a.ts'], undefined);
    assert.deepEqual(targets, { backend: ['src/a.ts'] });
    assert.equal(count, 0);
  });

  it('leaves out a file with only deleted lines', () => {
    assert.deepEqual(chooseTargets(['backend/src/a.ts'], new Map([['backend/src/a.ts', []]])).targets, {});
  });

  for (const path of ['backend/src/*.ts', 'backend/src/a,b.ts', 'backend/src/!a.ts', 'backend/src/a b.ts', 'backend/src/[a].ts', 'noslash']) {
    it(`does not pass ${JSON.stringify(path)} to Stryker, where it could mean a pattern`, () => {
      const { targets, skipped_paths: skipped } = chooseTargets([path], undefined);
      assert.deepEqual(targets, {});
      assert.deepEqual(skipped, [path]);
    });
  }
});

describe('summarizeMutationReport', () => {
  const report = {
    files: {
      'src/a.ts': {
        source: "const a = todo === 'new';\nif (b) {\n  c();\n}\n",
        mutants: [
          { status: 'Killed', mutatorName: 'BlockStatement', location: location(2, 8, 2) },
          { status: 'Timeout', mutatorName: 'BlockStatement', location: location(2, 8, 2) },
          { status: 'Survived', mutatorName: 'ConditionalExpression', replacement: 'false', location: location(1, 11, 25) },
          { status: 'NoCoverage', mutatorName: 'BlockStatement', replacement: '{}', location: { start: { line: 2, column: 8 }, end: { line: 4, column: 2 } } },
          { status: 'Survived', mutatorName: 'StringLiteral', replacement: '""', location: location(1, 20, 25) },
          { status: 'RuntimeError', mutatorName: 'Regex', location: location(1) },
          { status: 'CompileError', mutatorName: 'Regex', location: location(1) },
        ],
      },
    },
  };

  it('counts each status', () => {
    const { total, caught, survived, no_coverage: noCoverage, errors } = summarizeMutationReport(report, 'backend');
    assert.deepEqual({ total, caught, survived, noCoverage, errors }, { total: 7, caught: 2, survived: 2, noCoverage: 1, errors: 2 });
  });

  it('does not count a mutant that errored as caught or missed', () => {
    assert.equal(summarizeMutationReport(report, 'backend').mutants.length, 3);
  });

  it('names the file from the repository root and reads the code the mutant changed', () => {
    const [first] = summarizeMutationReport(report, 'backend').mutants;
    assert.deepEqual(first, { path: 'backend/src/a.ts', line: 1, status: 'Survived', mutator: 'ConditionalExpression', original: "todo === 'new'", replacement: 'false', data_only: false });
  });

  it('shortens code that spans lines', () => {
    assert.equal(summarizeMutationReport(report, 'backend').mutants[1].original, '{ ...');
  });

  it('marks literals as data', () => {
    assert.equal(summarizeMutationReport(report, 'backend').mutants[2].data_only, true);
    assert.ok(DATA_MUTATORS.has('StringLiteral'));
    assert.ok(!DATA_MUTATORS.has('ConditionalExpression'));
  });

  it('removes control characters and credentials from code taken from the branch', () => {
    const dirty = { files: { 'src/a.ts': { source: 'x', mutants: [{ status: 'Survived', mutatorName: 'StringLiteral', replacement: '\u001b[2Jsk-ant-abc123', location: location(1) }] } } };
    assert.equal(summarizeMutationReport(dirty, 'backend').mutants[0].replacement, '[REDACTED]');
  });

  it('survives a report with no files', () => {
    assert.equal(summarizeMutationReport({}, 'backend').total, 0);
  });
});

describe('mutationFeedback', () => {
  it('has nothing to say with no mutants or no result', () => {
    assert.equal(mutationFeedback({ mutants: [] }), null);
    assert.equal(mutationFeedback(undefined), null);
  });

  it('has nothing to say when only data mutants survived', () => {
    assert.equal(mutationFeedback({ mutants: [mutant({ data_only: true })] }), null);
  });

  it('lists a behavior mutant with its place and change, and leaves data out', () => {
    const text = mutationFeedback({ mutants: [mutant({ path: 'backend/src/a.ts', line: 7, original: 'x > 0', replacement: 'x >= 0' }), mutant({ line: 8, original: 'label', data_only: true })] });
    assert.match(text, /backend\/src\/a\.ts:7: `x > 0` became `x >= 0`/);
    assert.doesNotMatch(text, /label/);
  });

  it('says when no test runs the code at all', () => {
    assert.match(mutationFeedback({ mutants: [mutant({ status: 'NoCoverage' })] }), /no test runs this code/);
  });

  it('caps the list and says how many more there are', () => {
    const mutants = Array.from({ length: MAX_FEEDBACK_MUTANTS + 3 }, (_, line) => mutant({ line }));
    const text = mutationFeedback({ mutants });
    assert.equal((text.match(/^- backend/gm) ?? []).length, MAX_FEEDBACK_MUTANTS);
    assert.match(text, /and 3 more/);
  });

  it('orders by file and line', () => {
    const ordered = actionableMutants({ mutants: [mutant({ path: 'b.ts', line: 1 }), mutant({ path: 'a.ts', line: 9 }), mutant({ path: 'a.ts', line: 2 })] });
    assert.deepEqual(ordered.map(({ path, line }) => `${path}:${line}`), ['a.ts:2', 'a.ts:9', 'b.ts:1']);
  });
});

describe('nextRepair', () => {
  const state = (overrides = {}) => ({ outcome: 'tests_added', mutation: { mutants: [mutant()] }, round: 0, maxRounds: 2, mutationRounds: 0, ...overrides });

  it('repairs a rejection', () => {
    assert.equal(nextRepair(state({ outcome: 'tests_rejected', mutation: undefined })), 'gate');
  });

  it('repairs surviving behavior mutants', () => {
    assert.equal(nextRepair(state()), 'mutation');
  });

  it('stops when no rounds are left, for either reason', () => {
    assert.equal(nextRepair(state({ round: 2 })), null);
    assert.equal(nextRepair(state({ outcome: 'tests_rejected', round: 2 })), null);
  });

  it('allows no round at all when the limit is 0', () => {
    assert.equal(nextRepair(state({ maxRounds: 0 })), null);
  });

  it('runs one round for mutants at most, because some cannot be caught', () => {
    assert.equal(MAX_MUTATION_ROUNDS, 1);
    assert.equal(nextRepair(state({ round: 1, mutationRounds: 1 })), null);
  });

  it('still repairs a rejection after a round for mutants', () => {
    assert.equal(nextRepair(state({ outcome: 'tests_rejected', round: 1, mutationRounds: 1 })), 'gate');
  });

  it('does not repair for data mutants alone', () => {
    assert.equal(nextRepair(state({ mutation: { mutants: [mutant({ data_only: true })] } })), null);
  });

  it('does not repair when the mutation check did not run', () => {
    assert.equal(nextRepair(state({ mutation: undefined })), null);
  });

  it('never repairs a run that needed no tests, or a failed agent', () => {
    assert.equal(nextRepair(state({ outcome: 'no_tests_needed' })), null);
    assert.equal(nextRepair(state({ outcome: 'agent_failed' })), null);
  });
});

describe('gateFeedback', () => {
  it('says which check failed, with tests, rules, paths and logs', () => {
    const text = gateFeedback({
      failures: [
        { check: 'new-tests', package: 'frontend', message: '1 test(s) failed.', tests: [{ id: 'a > b', message: 'expected 1' }] },
        { check: 'test-rules', message: '1 rule violation(s).', violations: [{ rule: 'snapshot-assertion', path: 'x.test.ts', line: 3, message: 'No snapshots.' }] },
        { check: 'scope', message: '1 path.', paths: [{ path: 'src/a.ts', reason: 'is outside the test allowlist' }] },
        { check: 'typecheck', package: 'backend', message: 'No.', log: 'TS2345' },
      ],
    });
    for (const expected of ['new-tests in frontend', 'a > b', 'expected 1', 'snapshot-assertion in x.test.ts:3', 'src/a.ts is outside the test allowlist', 'TS2345']) {
      assert.ok(text.includes(expected), expected);
    }
  });

  it('keeps a long log short, and keeps its end', () => {
    const text = gateFeedback({ failures: [{ check: 'typecheck', message: 'No.', log: `${'x'.repeat(5000)}END` }] });
    assert.ok(text.length < 1200);
    assert.ok(text.includes('END'));
  });

  it('lists a limited number of tests', () => {
    const tests = Array.from({ length: 7 }, (_, index) => ({ id: `test ${index}` }));
    const text = gateFeedback({ failures: [{ check: 'new-tests', message: 'No.', tests }] });
    assert.ok(text.includes('test 4'));
    assert.ok(!text.includes('test 5'));
    assert.match(text, /and 2 more/);
  });

  it('removes credentials from a log', () => {
    assert.ok(!gateFeedback({ failures: [{ check: 'typecheck', message: 'No.', log: 'sk-ant-secret123' }] }).includes('secret123'));
  });
});

describe('strykerConfig', () => {
  it('uses forks, because a zone set in a worker thread does not apply', () => {
    assert.equal(strykerConfig({ packageName: 'frontend', mutate: [], reportFile: 'r' }).vitest.pool, 'forks');
  });

  it('uses the Vitest config of each package', () => {
    assert.equal(strykerConfig({ packageName: 'backend', mutate: [], reportFile: 'r' }).vitest.configFile, 'vitest.config.ts');
    assert.equal(strykerConfig({ packageName: 'frontend', mutate: [], reportFile: 'r' }).vitest.configFile, 'vite.config.ts');
  });
});

describe('runMutation', () => {
  let root;
  let repo;

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mutate-test-')));
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    repo = mkdtempSync(join(root, 'repo-'));
    mkdirSync(join(repo, 'backend'));
    mkdirSync(join(repo, 'frontend'));
  });

  const reportOf = { files: { 'src/a.ts': { source: 'x', mutants: [{ status: 'Killed', mutatorName: 'BlockStatement', location: location(1) }, { status: 'Survived', mutatorName: 'ConditionalExpression', replacement: 'y', location: location(1) }] } } };

  /** Stands in for Stryker and for the diff. It reads the config the way Stryker would. */
  const fakeExec = ({ hunks = {}, stryker = {} } = {}) => {
    const calls = [];
    const exec = (command, args, options) => {
      if (command === 'git') return { status: 0, stdout: hunks[args.at(-1)] ?? '', stderr: '' };
      const config = JSON.parse(readFileSync(args.at(-1), 'utf8'));
      calls.push({ args, options, config, packageName: options.cwd.split('/').at(-1) });
      mkdirSync(join(options.cwd, '.stryker-tmp'), { recursive: true });
      if (stryker.writeReport !== false) writeFileSync(config.jsonReporter.fileName, JSON.stringify(reportOf));
      return { status: stryker.status ?? 0, stdout: stryker.stdout ?? '', stderr: stryker.stderr ?? '', timedOut: stryker.timedOut };
    };
    return { exec, calls };
  };

  it('runs Stryker in each package with changes, with the changed lines', () => {
    const { exec, calls } = fakeExec({ hunks: { 'backend/src/a.ts': '@@ -1 +1,2 @@\n', 'frontend/src/b.ts': '@@ -8,0 +9 @@\n' } });
    const result = runMutation({ repo, sourceFiles: ['backend/src/a.ts', 'frontend/src/b.ts'], mergeBase: 'base', exec });
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls.map(({ packageName, config }) => [packageName, config.mutate]), [['backend', ['src/a.ts:1-2']], ['frontend', ['src/b.ts:9-9']]]);
    assert.equal(result.mutants.length, 2);
    assert.equal(result.packages.backend.caught, 1);
    assert.equal(result.packages.backend.mutants, undefined);
  });

  it('applies the time limit to Stryker', () => {
    const { exec, calls } = fakeExec();
    runMutation({ repo, sourceFiles: ['backend/src/a.ts'], exec });
    assert.equal(calls[0].options.timeoutMs, MUTATION_TIMEOUT_MS);
  });

  it('never takes the Stryker config from the branch', () => {
    const { exec, calls } = fakeExec();
    runMutation({ repo, sourceFiles: ['backend/src/a.ts'], exec });
    assert.ok(!calls[0].args.at(-1).startsWith(repo));
  });

  it('removes the sandbox and leaves no report behind', () => {
    const { exec } = fakeExec();
    runMutation({ repo, sourceFiles: ['backend/src/a.ts'], exec });
    assert.equal(existsSync(join(repo, 'backend/.stryker-tmp')), false);
    assert.equal(existsSync(join(repo, 'backend/mutation.json')), false);
  });

  it('skips a change that is too large, and runs nothing', () => {
    const { exec, calls } = fakeExec({ hunks: { 'backend/src/a.ts': `@@ -0,0 +1,${MAX_CHANGED_LINES + 1} @@\n` } });
    const result = runMutation({ repo, sourceFiles: ['backend/src/a.ts'], mergeBase: 'base', exec });
    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /over the limit/);
    assert.equal(calls.length, 0);
  });

  it('runs at exactly the limit', () => {
    const { exec, calls } = fakeExec({ hunks: { 'backend/src/a.ts': `@@ -0,0 +1,${MAX_CHANGED_LINES} @@\n` } });
    assert.equal(runMutation({ repo, sourceFiles: ['backend/src/a.ts'], mergeBase: 'base', exec }).status, 'completed');
    assert.equal(calls.length, 1);
  });

  it('skips when no file has changed lines', () => {
    const { exec, calls } = fakeExec();
    assert.equal(runMutation({ repo, sourceFiles: ['backend/src/a.ts'], mergeBase: 'base', exec }).status, 'skipped');
    assert.equal(calls.length, 0);
  });

  it('reports a timeout as incomplete, not as a failed test', () => {
    const { exec } = fakeExec({ stryker: { timedOut: true, status: null, writeReport: false } });
    const result = runMutation({ repo, sourceFiles: ['backend/src/a.ts'], exec });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.packages.backend.status, 'timed_out');
    assert.deepEqual(result.mutants, []);
  });

  it('reports a crash as incomplete and keeps a clean log', () => {
    const { exec } = fakeExec({ stryker: { status: 1, stderr: 'There were failed tests\u001b[31m sk-ant-abc123', writeReport: false } });
    const result = runMutation({ repo, sourceFiles: ['backend/src/a.ts'], exec });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.packages.backend.status, 'failed');
    assert.match(result.packages.backend.log, /There were failed tests \[REDACTED\]/);
  });

  it('treats a success with no report as a failure, not as nothing found', () => {
    const { exec } = fakeExec({ stryker: { writeReport: false } });
    const result = runMutation({ repo, sourceFiles: ['backend/src/a.ts'], exec });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.packages.backend.status, 'failed');
    assert.match(result.packages.backend.log, /wrote no report/);
  });

  it('treats a broken report as a failure', () => {
    const exec = (command, args) => {
      writeFileSync(JSON.parse(readFileSync(args.at(-1), 'utf8')).jsonReporter.fileName, 'not json');
      return { status: 0, stdout: '', stderr: '' };
    };
    assert.equal(runMutation({ repo, sourceFiles: ['backend/src/a.ts'], exec }).packages.backend.status, 'failed');
  });

  it('keeps the result of the other package when one fails', () => {
    let count = 0;
    const { exec: good } = fakeExec();
    const exec = (command, args, options) => {
      count += 1;
      return count === 1 ? { status: 1, stdout: '', stderr: 'boom' } : good(command, args, options);
    };
    const result = runMutation({ repo, sourceFiles: ['backend/src/a.ts', 'frontend/src/b.ts'], exec });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.packages.backend.status, 'failed');
    assert.equal(result.packages.frontend.status, 'completed');
  });

  it('says which paths it left out', () => {
    const { exec } = fakeExec();
    assert.deepEqual(runMutation({ repo, sourceFiles: ['backend/src/a.ts', 'backend/src/*.ts'], exec }).skipped_paths, ['backend/src/*.ts']);
  });
});
