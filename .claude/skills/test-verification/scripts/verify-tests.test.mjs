import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnv, runBaseline, runVerify } from './verify-tests.mjs';

const SCRIPT = fileURLToPath(new URL('./verify-tests.mjs', import.meta.url));
const COMMITTER = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const NEW_TEST = 'backend/tests/new.test.ts';
const NEW_TEST_BODY = "it('new behavior', () => { expect(value).toBe(1); });\n";

let root;
let repo;

const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...COMMITTER } });

const write = (path, content) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};

const test = (file, name, status = 'passed', message = 'boom') => ({ file, name, status, message });

/** Builds a Vitest JSON report. A failed test also fails the report. */
function report(pkg, tests) {
  const byFile = new Map();
  for (const entry of tests) byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
  return {
    success: tests.every(({ status }) => status === 'passed'),
    testResults: [...byFile].map(([file, entries]) => ({
      name: join(repo, pkg, file),
      status: entries.some(({ status }) => status === 'failed') ? 'failed' : 'passed',
      assertionResults: entries.map(({ name, status, message }) => ({
        fullName: name,
        status,
        failureMessages: status === 'failed' ? [message] : [],
      })),
    })),
  };
}

const metric = (pct) => ({ pct, covered: pct, total: 100 });
const metrics = (pct) => ({ lines: metric(pct), branches: metric(pct), functions: metric(pct), statements: metric(pct) });

/**
 * Stands in for npm and keeps real git. `behavior` chooses each outcome:
 * tests(pkg, script, args, runIndex) returns the tests of a run, or null for no report.
 */
function fakeExec(behavior = {}) {
  const calls = [];
  const runsByScript = new Map();
  const exec = (command, args, options) => {
    if (command === 'git') {
      const result = spawnSync('git', args, { cwd: options.cwd, encoding: 'utf8', env: { ...process.env, ...COMMITTER } });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }
    calls.push({ command, args, cwd: options.cwd });
    if (args[0] === 'exec') return { status: behavior.formatStatus ?? 0, stdout: '', stderr: behavior.formatLog ?? '' };
    const [, pkg, , script] = args;
    if (script === 'typecheck') {
      return { status: behavior.typecheckStatus?.[pkg] ?? 0, stdout: '', stderr: behavior.typecheckLog ?? '' };
    }
    const key = `${pkg}:${script}`;
    const runIndex = runsByScript.get(key) ?? 0;
    runsByScript.set(key, runIndex + 1);
    const tests = behavior.tests ? behavior.tests(pkg, script, args, runIndex) : [test('tests/new.test.ts', 'new behavior')];
    const outputArg = args.find((arg) => arg.startsWith('--outputFile='));
    if (tests !== null) {
      writeFileSync(outputArg.slice('--outputFile='.length), JSON.stringify(report(pkg, tests)));
      if (script === 'test:coverage') {
        const pct = behavior.coveragePct ?? 80;
        write(`${pkg}/coverage/coverage-summary.json`, JSON.stringify({ total: metrics(pct), [join(repo, pkg, 'src/a.ts')]: metrics(pct) }));
        write(`${pkg}/coverage/lcov.info`, 'TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n');
      }
    }
    const status = behavior.status ?? (tests === null || tests.some(({ status: value }) => value === 'failed') ? 1 : 0);
    return { status, stdout: 'output', stderr: behavior.log ?? '', timedOut: behavior.timedOut };
  };
  return { exec, calls };
}

const npmCalls = (calls, script) => calls.filter(({ args }) => args[3] === script);

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-tests-test-')));
});

after(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  repo = mkdtempSync(join(root, 'repo-'));
  run('init', '-q', '-b', 'main');
  write('.gitignore', 'coverage/\n');
  write('backend/src/a.ts', 'export const a = 1;\n');
  write('backend/tests/router.test.ts', "it('lists tasks', () => { expect(a).toBe(1); expect(b).toBe(2); });\n");
  write('frontend/src/App.tsx', 'export const App = 1;\n');
  run('add', '-A');
  run('commit', '-q', '--no-gpg-sign', '-m', 'base');
});

describe('runVerify: scope', () => {
  it('has nothing to do on a clean tree, and runs nothing', () => {
    const { exec, calls } = fakeExec();
    const result = runVerify({ repo, exec });
    assert.equal(result.status, 'no_changes');
    assert.deepEqual(calls, []);
  });

  for (const [name, path] of [
    ['application code', 'backend/src/a.ts'],
    ['a new application file', 'backend/src/b.ts'],
    ['the package manifest', 'backend/package.json'],
    ['the test setup', 'frontend/src/test/setup.ts'],
    ['a workflow', '.github/workflows/ci.yml'],
    ['the hook', '.claude/hooks/guard-tools.mjs'],
  ]) {
    it(`fails on a change to ${name}, and runs nothing from the working tree`, () => {
      write(NEW_TEST, NEW_TEST_BODY);
      write(path, 'changed\n');
      const { exec, calls } = fakeExec();
      const result = runVerify({ repo, exec });
      assert.equal(result.status, 'failed');
      assert.equal(result.failures[0].check, 'scope');
      assert.deepEqual(result.failures[0].paths.map(({ path: failed }) => failed), [path]);
      assert.deepEqual(calls, [], 'no test or typecheck may run before the scope is proven');
    });
  }

  it('fails when a test file is deleted', () => {
    unlinkSync(join(repo, 'backend/tests/router.test.ts'));
    const { exec, calls } = fakeExec();
    const result = runVerify({ repo, exec });
    assert.equal(result.failures[0].check, 'scope');
    assert.match(result.failures[0].paths[0].reason, /deleted/);
    assert.deepEqual(calls, []);
  });

  it('fails on a symbolic link with an allowed name', () => {
    symlinkSync('/proc/self/environ', join(repo, 'backend/tests/link.test.ts'));
    const { exec, calls } = fakeExec();
    const result = runVerify({ repo, exec });
    assert.equal(result.failures[0].check, 'scope');
    assert.match(result.failures[0].paths[0].reason, /symbolic link/);
    assert.deepEqual(calls, []);
  });
});

describe('runVerify: passing', () => {
  it('passes a good new test and records what ran', () => {
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec, calls } = fakeExec();
    const result = runVerify({ repo, exec });
    assert.equal(result.status, 'passed', JSON.stringify(result.failures));
    assert.deepEqual(result.changed_files, [{ path: NEW_TEST, class: 'test' }]);
    assert.equal(result.packages.backend.typecheck.passed, true);
    assert.equal(result.packages.backend.new_tests.passed, true);
    assert.equal(result.packages.backend.full_package.passed, true);
    assert.deepEqual(Object.keys(result.packages), ['backend']);
    assert.equal(npmCalls(calls, 'test').length, 3, 'a new test runs three times');
    assert.equal(npmCalls(calls, 'test:coverage').length, 1, 'the whole package runs once');
    assert.equal(npmCalls(calls, 'typecheck').length, 1);
  });

  it('asks for coverage even when a test fails, so a red baseline keeps its numbers', () => {
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec, calls } = fakeExec();
    runVerify({ repo, exec });
    assert.ok(npmCalls(calls, 'test:coverage')[0].args.includes('--coverage.reportOnFailure'));
  });

  it('filters the repeated runs to the changed tests and requires assertions', () => {
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec, calls } = fakeExec();
    runVerify({ repo, exec });
    for (const { args } of npmCalls(calls, 'test')) {
      assert.ok(args.includes('tests/new.test.ts'));
      assert.ok(args.includes('--expect.requireAssertions'));
    }
  });

  it('shuffles the second and third run with fixed seeds', () => {
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec, calls } = fakeExec();
    runVerify({ repo, exec });
    const [first, second, third] = npmCalls(calls, 'test');
    assert.ok(!first.args.includes('--sequence.shuffle'));
    assert.ok(second.args.includes('--sequence.shuffle'));
    assert.ok(third.args.includes('--sequence.shuffle'));
    assert.notDeepEqual(
      second.args.find((arg) => arg.startsWith('--sequence.seed')),
      third.args.find((arg) => arg.startsWith('--sequence.seed')),
    );
  });

  it('formats only frontend files, with paths relative to the package', () => {
    write('frontend/src/lib/http.test.ts', NEW_TEST_BODY);
    const { exec, calls } = fakeExec({ tests: () => [test('src/lib/http.test.ts', 'new behavior')] });
    const result = runVerify({ repo, exec });
    assert.equal(result.status, 'passed', JSON.stringify(result.failures));
    const format = calls.find(({ args }) => args[0] === 'exec');
    assert.deepEqual(format.args.slice(-2), ['--write', 'src/lib/http.test.ts']);
    assert.equal(format.cwd, join(repo, 'frontend'));
    assert.equal(result.packages.frontend.format.passed, true);
  });

  it('does not run a formatter for the backend, which has none', () => {
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec, calls } = fakeExec();
    runVerify({ repo, exec });
    assert.equal(calls.find(({ args }) => args[0] === 'exec'), undefined);
  });

  it('runs each package that has changes', () => {
    write(NEW_TEST, NEW_TEST_BODY);
    write('frontend/src/lib/http.test.ts', NEW_TEST_BODY);
    const { exec } = fakeExec({
      tests: (pkg) => [test(pkg === 'backend' ? 'tests/new.test.ts' : 'src/lib/http.test.ts', 'new behavior')],
    });
    assert.deepEqual(Object.keys(runVerify({ repo, exec }).packages), ['backend', 'frontend']);
  });

  it('reports a changed line in an existing test, without failing', () => {
    write('backend/tests/router.test.ts', "it('lists tasks', () => { expect(a).toBe(1); expect(b).toBe(3); });\n");
    const { exec } = fakeExec();
    const result = runVerify({ repo, exec });
    assert.equal(result.status, 'passed', JSON.stringify(result.failures));
    assert.deepEqual(result.existing_tests_changed, [{ path: 'backend/tests/router.test.ts', changed_lines: 1 }]);
  });
});

describe('runVerify: shared test support', () => {
  it('a change to the design system mocks runs the whole frontend package and is reported apart', () => {
    write('frontend/src/design-system/mocks.tsx', 'export const Mock = 1;\n');
    const { exec, calls } = fakeExec({ tests: () => [test('src/App.test.tsx', 'renders')] });
    const result = runVerify({ repo, exec });
    assert.equal(result.status, 'passed', JSON.stringify(result.failures));
    assert.deepEqual(result.shared_test_support, ['frontend/src/design-system/mocks.tsx']);
    assert.equal(result.packages.frontend.shared_test_support_changed, true);
    assert.equal(npmCalls(calls, 'test:coverage').length, 1);
    assert.equal(npmCalls(calls, 'test').length, 0, 'there is no new test file to repeat');
  });

  for (const path of ['frontend/src/test/todoFixture.ts', 'backend/tests/fixture.ts']) {
    it(`${path} counts as shared support too`, () => {
      write(path, 'export const fixture = 1;\n');
      const { exec, calls } = fakeExec({ tests: () => [test('tests/router.test.ts', 'lists tasks')] });
      const result = runVerify({ repo, exec });
      assert.deepEqual(result.shared_test_support, [path]);
      assert.equal(npmCalls(calls, 'test:coverage').length, 1);
    });
  }

  it('fails when a shared support change breaks a test that was not changed', () => {
    write('backend/tests/fixture.ts', 'export const fixture = 2;\n');
    const { exec } = fakeExec({ tests: () => [test('tests/router.test.ts', 'lists tasks', 'failed')] });
    const result = runVerify({ repo, exec });
    assert.equal(result.status, 'failed');
    assert.equal(result.failures[0].check, 'full-package');
  });

  it('a normal test is not reported as shared support', () => {
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec } = fakeExec();
    const result = runVerify({ repo, exec });
    assert.deepEqual(result.shared_test_support, []);
    assert.equal(result.packages.backend.shared_test_support_changed, false);
  });
});

describe('runVerify: failing', () => {
  const failing = (tests, extra = {}) => {
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec, calls } = fakeExec({ tests, ...extra });
    return { result: runVerify({ repo, exec }), calls };
  };
  const checks = (result) => result.failures.map(({ check }) => check);

  it('fails on a forbidden pattern and still runs the rest, to report everything at once', () => {
    write(NEW_TEST, "it.only('new behavior', () => { expect(value).toBe(1); });\n");
    const { exec, calls } = fakeExec();
    const result = runVerify({ repo, exec });
    assert.equal(result.status, 'failed');
    assert.deepEqual(checks(result), ['test-rules']);
    assert.equal(result.failures[0].violations[0].rule, 'focused-or-skipped-test');
    assert.ok(npmCalls(calls, 'typecheck').length > 0);
  });

  it('fails when an existing test is removed from a file', () => {
    write('backend/tests/router.test.ts', "it('something else', () => { expect(a).toBe(1); expect(b).toBe(2); });\n");
    const { exec } = fakeExec();
    const result = runVerify({ repo, exec });
    assert.equal(result.failures[0].violations[0].rule, 'removed-test');
  });

  it('fails when assertions are removed from an existing test', () => {
    write('backend/tests/router.test.ts', "it('lists tasks', () => { expect(a).toBe(1); });\n");
    const { exec } = fakeExec();
    const result = runVerify({ repo, exec });
    assert.equal(result.failures[0].violations[0].rule, 'fewer-assertions');
  });

  it('fails when a test fails in every run', () => {
    const { result } = failing(() => [test('tests/new.test.ts', 'new behavior', 'failed')]);
    assert.ok(checks(result).includes('new-tests'));
    assert.deepEqual(result.packages.backend.new_tests.failed, ['backend/tests/new.test.ts > new behavior']);
    assert.match(result.failures[0].tests[0].message, /boom/);
  });

  it('fails a flaky test, which fails in only one of the three runs', () => {
    const { result } = failing((pkg, script, args, runIndex) => {
      const failedRun = script === 'test' && runIndex === 2;
      return [test('tests/new.test.ts', 'new behavior', failedRun ? 'failed' : 'passed')];
    });
    assert.deepEqual(checks(result), ['flaky-tests']);
    assert.equal(result.failures[0].tests[0].failed_runs, 1);
    assert.deepEqual(result.packages.backend.new_tests.flaky, ['backend/tests/new.test.ts > new behavior']);
  });

  it('fails when the repeated run gives no report', () => {
    const { result } = failing((pkg, script) => (script === 'test' ? null : [test('tests/new.test.ts', 'new behavior')]));
    assert.deepEqual(checks(result), ['new-tests']);
    assert.match(result.failures[0].message, /without a report/);
    assert.equal(result.packages.backend.new_tests.passed, false);
  });

  it('says so when a run timed out', () => {
    const { result } = failing(() => null, { timedOut: true });
    assert.match(result.failures[0].message, /timed out/);
    assert.match(result.failures[1].message, /timed out/);
  });

  it('fails when the whole package gives no report', () => {
    const { result } = failing((pkg, script) => (script === 'test:coverage' ? null : [test('tests/new.test.ts', 'new behavior')]));
    assert.deepEqual(checks(result), ['full-package']);
    assert.equal(result.packages.backend.full_package.passed, false);
  });

  it('fails when another test in the package breaks', () => {
    const { result } = failing((pkg, script) =>
      script === 'test:coverage'
        ? [test('tests/new.test.ts', 'new behavior'), test('tests/router.test.ts', 'lists tasks', 'failed')]
        : [test('tests/new.test.ts', 'new behavior')],
    );
    assert.deepEqual(checks(result), ['full-package']);
    assert.deepEqual(result.packages.backend.full_package.new_failures, ['backend/tests/router.test.ts > lists tasks']);
  });

  it('fails when the run exits badly with no failed test, as with a coverage threshold', () => {
    const { result } = failing(() => [test('tests/new.test.ts', 'new behavior')], { status: 1, log: 'ERROR: Coverage for lines does not meet threshold' });
    assert.ok(checks(result).includes('full-package'));
    const failure = result.failures.find(({ check }) => check === 'full-package');
    assert.match(failure.log, /threshold/);
  });

  it('fails on a type error', () => {
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec } = fakeExec({ typecheckStatus: { backend: 2 }, typecheckLog: "TS2345: Argument of type" });
    const result = runVerify({ repo, exec });
    assert.deepEqual(checks(result), ['typecheck']);
    assert.match(result.failures[0].log, /TS2345/);
    assert.equal(result.packages.backend.typecheck.passed, false);
  });

  it('fails when the formatter fails', () => {
    write('frontend/src/lib/http.test.ts', NEW_TEST_BODY);
    const { exec } = fakeExec({ formatStatus: 2, formatLog: 'SyntaxError', tests: () => [test('src/lib/http.test.ts', 'new behavior')] });
    const result = runVerify({ repo, exec });
    assert.deepEqual(checks(result), ['format']);
    assert.equal(result.packages.frontend.format.passed, false);
  });

  it('sanitizes logs from the branch', () => {
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec } = fakeExec({ typecheckStatus: { backend: 1 }, typecheckLog: '\u001b[31mred\u001b[0m sk-ant-api03-secret' });
    const { log } = runVerify({ repo, exec }).failures[0];
    assert.match(log, /red \[REDACTED\]/);
    assert.doesNotMatch(log, /\u001b|sk-ant/);
  });
});

describe('runVerify: baseline', () => {
  const baselineWith = (failed) => ({
    packages: { backend: { ran: true, total: 2, failed, coverage: { total: metrics(30), files: { 'backend/src/a.ts': metrics(10) } } } },
  });
  const tests = (pkg, script) =>
    script === 'test:coverage'
      ? [test('tests/new.test.ts', 'new behavior'), test('tests/router.test.ts', 'lists tasks', 'failed')]
      : [test('tests/new.test.ts', 'new behavior')];

  it('does not blame the agent for a test that was already red', () => {
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec } = fakeExec({ tests });
    const result = runVerify({ repo, exec, baseline: baselineWith(['backend/tests/router.test.ts > lists tasks']) });
    assert.equal(result.status, 'passed', JSON.stringify(result.failures));
    assert.deepEqual(result.packages.backend.full_package.baseline_failures, ['backend/tests/router.test.ts > lists tasks']);
    assert.deepEqual(result.packages.backend.full_package.new_failures, []);
  });

  it('blames a test that was green before', () => {
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec } = fakeExec({ tests });
    assert.equal(runVerify({ repo, exec, baseline: baselineWith([]) }).status, 'failed');
  });

  it('compares coverage with the baseline for the given source files', () => {
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec } = fakeExec({ coveragePct: 80 });
    const result = runVerify({ repo, exec, baseline: baselineWith([]), sourceFiles: ['backend/src/a.ts'] });
    const { total, files } = result.packages.backend.coverage;
    assert.equal(total.before.lines.pct, 30);
    assert.equal(total.after.lines.pct, 80);
    assert.equal(files[0].before.lines.pct, 10);
    assert.equal(files[0].after.lines.pct, 80);
    assert.equal(files[0].changed_lines, null, 'no merge base was given');
  });

  it('reports coverage of changed lines when a merge base is given', () => {
    const mergeBase = run('rev-parse', 'HEAD').trim();
    write('backend/src/a.ts', 'export const a = 2;\nexport const b = 2;\n');
    run('add', '-A');
    run('commit', '-q', '--no-gpg-sign', '-m', 'change');
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec } = fakeExec();
    const result = runVerify({ repo, exec, mergeBase, sourceFiles: ['backend/src/a.ts'] });
    assert.deepEqual(result.packages.backend.coverage.files[0].changed_lines, { total: 2, covered: 1, uncovered: [2] });
  });

  it('does not read an old coverage report after a crash', () => {
    write('backend/coverage/coverage-summary.json', JSON.stringify({ total: metrics(99) }));
    write('backend/coverage/lcov.info', '');
    write(NEW_TEST, NEW_TEST_BODY);
    const { exec } = fakeExec({ tests: (pkg, script) => (script === 'test:coverage' ? null : [test('tests/new.test.ts', 'new behavior')]) });
    const result = runVerify({ repo, exec });
    assert.equal(result.packages.backend.coverage.total.after, null);
  });
});

describe('runBaseline', () => {
  it('records failed tests and coverage for each package', () => {
    const { exec } = fakeExec({
      tests: (pkg) => (pkg === 'backend' ? [test('tests/a.test.ts', 'red', 'failed'), test('tests/a.test.ts', 'green')] : [test('src/a.test.ts', 'green')]),
    });
    const result = runBaseline({ repo, exec });
    assert.deepEqual(result.packages.backend.failed, ['backend/tests/a.test.ts > red']);
    assert.equal(result.packages.backend.total, 2);
    assert.equal(result.packages.backend.coverage.total.lines.pct, 80);
    assert.deepEqual(result.packages.frontend.failed, []);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'it must survive being written to a file');
  });

  it('records a package that could not run', () => {
    const { exec } = fakeExec({ tests: () => null });
    const { packages } = runBaseline({ repo, exec, packages: ['backend'] });
    assert.deepEqual(packages.backend, { ran: false, total: 0, failed: [], coverage: null });
  });
});

describe('childEnv', () => {
  it('removes credentials and sets a stable environment', () => {
    const env = childEnv({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'x',
      ANTHROPIC_AUTH_TOKEN: 'x',
      CLAUDE_CODE_OAUTH_TOKEN: 'x',
      GITHUB_TOKEN: 'x',
      GH_TOKEN: 'x',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'x',
      ACTIONS_RUNTIME_TOKEN: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      NPM_TOKEN: 'x',
      TZ: 'Europe/Warsaw',
    });
    assert.deepEqual(env, { PATH: '/bin', CI: 'true', TZ: 'UTC' });
  });
});

describe('command line', () => {
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });

  it('exits with 0 on a clean tree and prints JSON', () => {
    const result = cli('verify');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'no_changes');
  });

  it('exits with 1 on a scope failure and writes the report', () => {
    write('backend/src/a.ts', 'changed\n');
    const out = join(repo, '.git/report/verify.json');
    const result = cli('verify', '--out', out);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).failures[0].check, 'scope');
  });

  for (const [name, args] of [
    ['no command', []],
    ['an unknown command', ['deploy']],
    ['an unknown option', ['verify', '--nope']],
    ['baseline with no output path', ['baseline']],
    ['an unknown package', ['baseline', '--out', 'x.json', '--packages', 'evil']],
    ['an unknown base', ['verify', '--base', 'does-not-exist']],
  ]) {
    it(`exits with 2 on ${name}`, () => {
      const result = cli(...args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /^verify-tests: /);
    });
  }

  it('exits with 2 outside a repository', () => {
    const outside = mkdtempSync(join(root, 'plain-'));
    const result = spawnSync(process.execPath, [SCRIPT, 'verify'], { cwd: outside, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not a git repository/);
  });
});
