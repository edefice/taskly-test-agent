import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARTIFACTS_DIR, claudeArgs, claudeEnv, decideOutcome, interpretRun, isSupportedVersion, parseOptions, runPipeline } from './test-agent.mjs';

const SCRIPT = fileURLToPath(new URL('./test-agent.mjs', import.meta.url));
const COMMITTER = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const TEST_FILE = 'backend/tests/a.test.ts';

const validResult = (overrides = {}) => ({
  decision: 'tests_added',
  reasoning: 'The file had no tests.',
  skills_used: ['pr-change-analysis'],
  files: [{ path: TEST_FILE, action: 'created' }],
  tests: [{ file: TEST_FILE, name: 'a', behavior: 'It does a thing.' }],
  existing_tests_changed: [],
  suspected_bugs: [],
  regressions: [],
  ...overrides,
});

const transcriptOf = (overrides = {}) => ({ skills: [], tools: [], model: 'm', turns: 1, costUsd: 0.1, structuredOutput: validResult(), outcome: 'success', denials: 0, ...overrides });

describe('parseOptions', () => {
  it('reads a diff run with defaults', () => {
    const options = parseOptions(['--base', 'main']);
    assert.equal(options.base, 'main');
    assert.equal(options.dryRun, false);
    assert.equal(options.noBash, false);
    assert.ok(options.maxTurns > 0);
    assert.ok(options.maxBudgetUsd > 0);
  });

  it('splits a list of files', () => {
    assert.deepEqual(parseOptions(['--files', 'a.ts, b.ts']).files, ['a.ts', 'b.ts']);
  });

  it('reads the feedback file path, and has none by default', () => {
    assert.equal(parseOptions(['--base', 'main', '--feedback', 'why.txt']).feedback, 'why.txt');
    assert.equal(parseOptions(['--base', 'main']).feedback, undefined);
  });

  it('has the mutation check on and no repair rounds by default, because rounds cost money', () => {
    const options = parseOptions(['--base', 'main']);
    assert.equal(options.noMutation, false);
    assert.equal(options.repairRounds, 0);
  });

  it('reads the mutation and repair options', () => {
    const options = parseOptions(['--base', 'main', '--no-mutation', '--repair-rounds', '2', '--mutation-repair']);
    assert.equal(options.noMutation, true);
    assert.equal(options.repairRounds, 2);
    assert.equal(options.mutationRepair, true);
  });

  it('leaves repair for mutants off by default', () => {
    assert.equal(parseOptions(['--base', 'main']).mutationRepair, false);
  });

  for (const value of ['3', '-1', '1.5', 'x']) {
    it(`rejects ${value} repair rounds`, () => {
      assert.throws(() => parseOptions(['--base', 'main', '--repair-rounds', value]), /--repair-rounds/);
    });
  }

  for (const [name, args] of [
    ['neither mode', []],
    ['both modes', ['--base', 'main', '--files', 'a.ts']],
    ['a bad turn limit', ['--base', 'main', '--max-turns', '0']],
    ['a bad turn limit that is not a number', ['--base', 'main', '--max-turns', 'x']],
    ['a bad budget', ['--base', 'main', '--max-budget-usd', '-1']],
    ['an unknown option', ['--base', 'main', '--nope']],
  ]) {
    it(`rejects ${name}`, () => {
      assert.throws(() => parseOptions(args));
    });
  }
});

describe('isSupportedVersion', () => {
  for (const version of ['2.1.295 (Claude Code)', '2.1.317', '2.2.0', '3.0.0']) {
    it(`accepts ${version}`, () => assert.equal(isSupportedVersion(version), true));
  }
  for (const version of ['2.1.294', '2.1.227 (Claude Code)', '2.0.999', '1.9.999', '', null, 'unknown']) {
    it(`rejects ${version}`, () => assert.equal(isSupportedVersion(version), false));
  }
});

describe('claudeArgs', () => {
  const args = (overrides = {}) => claudeArgs({ prompt: 'p', repo: '/repo', maxTurns: 5, maxBudgetUsd: 1, noBash: false, ...overrides });
  const allowed = (list) => list[list.indexOf('--allowedTools') + 1].split(',');

  it('runs the agent with limits and only project settings', () => {
    const list = args();
    assert.deepEqual(list.slice(0, 4), ['-p', 'p', '--agent', 'unit-test-agent']);
    assert.equal(list[list.indexOf('--max-turns') + 1], '5');
    assert.equal(list[list.indexOf('--max-budget-usd') + 1], '1');
    assert.equal(list[list.indexOf('--setting-sources') + 1], 'project');
    assert.equal(list[list.indexOf('--settings') + 1], '/repo/.claude/agent-run.settings.json');
  });

  it('asks for the result in the schema', () => {
    const list = args();
    assert.equal(JSON.parse(list[list.indexOf('--json-schema') + 1]).title, 'Unit test agent result');
  });

  it('sends a schema that Claude Code accepts, which means no $schema key', () => {
    const list = args();
    assert.equal(JSON.parse(list[list.indexOf('--json-schema') + 1]).$schema, undefined);
  });

  it('does not pre-approve bare Read, Grep or Glob, which would open files outside the repository', () => {
    for (const tool of ['Read', 'Grep', 'Glob']) assert.ok(!allowed(args()).includes(tool));
  });

  it('selects the search tools with --tools, which approves nothing', () => {
    const list = args();
    const tools = list[list.indexOf('--tools') + 1].split(',');
    for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'Skill', 'StructuredOutput']) assert.ok(tools.includes(tool), tool);
  });

  it('leaves Bash out of --tools with noBash', () => {
    const list = args({ noBash: true });
    assert.ok(!list[list.indexOf('--tools') + 1].split(',').includes('Bash'));
  });

  it('never approves all of Bash', () => {
    assert.ok(!allowed(args()).includes('Bash'));
    assert.ok(allowed(args()).includes('Bash(npm --prefix backend run *)'));
  });

  it('never skips permissions and never uses bare mode, which would skip the hook', () => {
    const text = args().join(' ');
    assert.doesNotMatch(text, /--dangerously-skip-permissions|--bare|bypassPermissions/);
  });

  it('removes Bash completely with noBash, as in CI', () => {
    const list = args({ noBash: true });
    assert.equal(list[list.indexOf('--disallowedTools') + 1], 'Bash');
    assert.ok(!allowed(list).some((tool) => tool.startsWith('Bash')));
  });

  it('keeps Bash without noBash', () => {
    assert.ok(!args().includes('--disallowedTools'));
  });
});

describe('claudeEnv', () => {
  it('turns on the hook and the environment scrub', () => {
    const env = claudeEnv({ PATH: '/bin' });
    assert.equal(env.UNIT_TEST_AGENT_ENFORCE, '1');
    assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
    assert.equal(env.PATH, '/bin');
  });
});

describe('interpretRun', () => {
  const run = { status: 0, timedOut: false, startError: null };

  it('accepts a valid result', () => {
    assert.deepEqual(interpretRun({ run, transcript: transcriptOf() }), { failureReason: null, result: validResult() });
  });

  for (const [name, input, expected] of [
    ['a missing binary', { run: { ...run, startError: 'ENOENT' }, transcript: transcriptOf() }, /could not start/],
    ['a timeout', { run: { ...run, timedOut: true }, transcript: transcriptOf() }, /timed out/],
    ['the turn limit', { run, transcript: transcriptOf({ outcome: 'error_max_turns' }) }, /turn limit/],
    ['the budget limit', { run, transcript: transcriptOf({ outcome: 'error_max_budget_usd' }) }, /budget limit/],
    ['an execution error', { run, transcript: transcriptOf({ outcome: 'error_during_execution' }) }, /execution error/],
    ['a transcript with no final result, as after an API failure', { run, transcript: transcriptOf({ outcome: null }) }, /without a final result/],
    ['an unknown outcome', { run, transcript: transcriptOf({ outcome: 'surprise' }) }, /without a final result/],
    ['no structured output', { run, transcript: transcriptOf({ structuredOutput: null }) }, /no structured result/],
    ['an invalid result', { run, transcript: transcriptOf({ structuredOutput: { decision: 'approved' } }) }, /failed validation/],
  ]) {
    it(`fails on ${name}`, () => {
      const { failureReason, result } = interpretRun(input);
      assert.match(failureReason, expected);
      assert.equal(result, null);
    });
  }

  it('reports a failure that the agent itself declared, and keeps its result', () => {
    const declared = validResult({ decision: 'failed', files: [], tests: [], reasoning: 'I could not mock it.' });
    const { failureReason, result } = interpretRun({ run, transcript: transcriptOf({ structuredOutput: declared }) });
    assert.match(failureReason, /I could not mock it/);
    assert.equal(result.decision, 'failed');
  });
});

describe('decideOutcome', () => {
  const verification = (overrides = {}) => ({ status: 'passed', changed_files: [{ path: TEST_FILE, class: 'test' }], existing_tests_changed: [], failures: [], ...overrides });

  it('accepts tests that pass and match the result', () => {
    assert.equal(decideOutcome({ result: validResult(), verification: verification() }), 'tests_added');
  });

  it('rejects tests that fail the gate', () => {
    assert.equal(decideOutcome({ result: validResult(), verification: verification({ status: 'failed' }) }), 'tests_rejected');
  });

  it('accepts a decision to write no tests when nothing changed', () => {
    const result = validResult({ decision: 'no_tests_needed', files: [], tests: [] });
    assert.equal(decideOutcome({ result, verification: verification({ status: 'no_changes', changed_files: [] }) }), 'no_tests_needed');
  });

  it('rejects a claim of no tests when files did change', () => {
    const result = validResult({ decision: 'no_tests_needed', files: [], tests: [] });
    const report = verification();
    assert.equal(decideOutcome({ result, verification: report }), 'tests_rejected');
    assert.equal(report.failures[0].check, 'result-mismatch');
    assert.equal(report.status, 'failed');
  });

  it('rejects a claim of tests when nothing changed', () => {
    const report = verification({ status: 'no_changes', changed_files: [] });
    assert.equal(decideOutcome({ result: validResult(), verification: report }), 'tests_rejected');
    assert.equal(report.failures[0].check, 'result-mismatch');
  });
});

describe('runPipeline', () => {
  let root;
  let repo;
  const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...COMMITTER } });
  const write = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const commit = () => {
    run('add', '-A');
    run('commit', '-q', '--no-gpg-sign', '-m', 'x');
  };

  const fakes = (overrides = {}) => {
    const calls = { baseline: [], verify: [], mutate: [], claude: [], logs: [] };
    return {
      calls,
      deps: {
        version: () => '2.1.317 (Claude Code)',
        baseline: (options) => {
          calls.baseline.push(options);
          return { schema_version: 1, packages: {} };
        },
        verify: (options) => {
          calls.verify.push(options);
          return { schema_version: 1, status: 'passed', changed_files: [{ path: TEST_FILE, class: 'test' }], existing_tests_changed: [], shared_test_support: [], packages: {}, failures: [] };
        },
        mutate: (options) => {
          calls.mutate.push(options);
          return { schema_version: 1, status: 'completed', reason: null, skipped_paths: [], packages: {}, mutants: [] };
        },
        claude: ({ args, transcriptPath }) => {
          calls.claude.push(args);
          write(TEST_FILE, `// attempt ${calls.claude.length}\n`);
          writeFileSync(
            transcriptPath,
            [
              { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' },
              { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'backend-unit-tests' } }] } },
              { type: 'result', subtype: 'success', num_turns: 7, total_cost_usd: 0.25, structured_output: validResult(), permission_denials: [{}] },
            ]
              .map((line) => JSON.stringify(line))
              .join('\n'),
          );
          return { status: 0, timedOut: false, startError: null };
        },
        log: (text) => calls.logs.push(text),
        ...overrides,
      },
    };
  };

  const options = (overrides = {}) => ({ repo, base: 'main', dryRun: false, noBash: false, maxTurns: 5, maxBudgetUsd: 1, ...overrides });
  const artifact = (name) => readFileSync(join(repo, ARTIFACTS_DIR, name), 'utf8');

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'test-agent-')));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    repo = mkdtempSync(join(root, 'repo-'));
    run('init', '-q', '-b', 'main');
    write('.gitignore', `${ARTIFACTS_DIR}/\n`);
    write('README.md', '# x\n');
    write('backend/src/a.ts', 'export const a = 1;\n');
    commit();
    run('switch', '-q', '-c', 'feature');
  });

  const changeSource = () => {
    write('backend/src/a.ts', 'export const a = 2;\n');
    commit();
  };

  it('runs analysis, baseline, agent and gate in order, and writes a report', () => {
    changeSource();
    const { deps, calls } = fakes();
    const result = runPipeline(options(), deps);
    assert.equal(result.outcome, 'tests_added');
    assert.equal(result.conclusion, 'success');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls.baseline[0].packages, ['backend']);
    assert.equal(calls.verify[0].mergeBase, run('merge-base', 'main', 'HEAD').trim());
    assert.deepEqual(calls.verify[0].sourceFiles, ['backend/src/a.ts']);
    const report = artifact('report.md');
    assert.match(report, /1 test written and verified/);
    assert.match(report, /Skills preloaded: `pr-change-analysis`, `backend-unit-tests`\. Skills invoked: `backend-unit-tests`\./);
    assert.match(report, /claude-sonnet-5-5/);
    assert.match(report, /7 turns/);
    assert.match(report, /\$0\.2500/);
    assert.match(report, /1 blocked tool call\b/);
    assert.match(report, /Prompt version `\d+`/);
  });

  it('passes the analysis to the agent in a data tag', () => {
    changeSource();
    const { deps, calls } = fakes();
    runPipeline(options(), deps);
    const prompt = calls.claude[0][1];
    assert.match(prompt, /<untrusted-analysis-[0-9a-f]+>/);
    assert.match(prompt, /backend\/src\/a\.ts/);
    assert.match(prompt, /When tests are not needed/);
    assert.equal(artifact('prompt.txt'), prompt);
  });

  describe('skills in the prompt and in the report', () => {
    const inPrompt = () => [...artifact('prompt.txt').matchAll(/<preloaded-skill name="([^"]+)">/g)].map((match) => match[1]);
    const inReport = () => JSON.parse(artifact('report-input.json')).preloaded_skills;

    for (const [name, change, expected] of [
      ['a backend source file', () => write('backend/src/a.ts', 'export const a = 2;\n'), ['pr-change-analysis', 'backend-unit-tests']],
      ['a frontend source file', () => write('frontend/src/b.ts', 'export const b = 1;\n'), ['pr-change-analysis', 'frontend-unit-tests']],
      [
        'source files in both packages',
        () => {
          write('backend/src/a.ts', 'export const a = 2;\n');
          write('frontend/src/b.ts', 'export const b = 1;\n');
        },
        ['pr-change-analysis', 'backend-unit-tests', 'frontend-unit-tests'],
      ],
      [
        'a backend source file and only documentation in the frontend',
        () => {
          write('backend/src/a.ts', 'export const a = 2;\n');
          write('frontend/README.md', '# x\n');
        },
        ['pr-change-analysis', 'backend-unit-tests'],
      ],
    ]) {
      it(`${name}: the report lists what the prompt contains`, () => {
        change();
        commit();
        const { deps } = fakes();
        runPipeline(options(), deps);
        assert.deepEqual(inPrompt(), expected);
        assert.deepEqual(inReport(), expected);
      });
    }

    it('a run on named files does the same', () => {
      const { deps } = fakes();
      runPipeline(options({ base: undefined, files: ['backend/src/a.ts'] }), deps);
      assert.deepEqual(inPrompt(), ['pr-change-analysis', 'backend-unit-tests']);
      assert.deepEqual(inReport(), ['pr-change-analysis', 'backend-unit-tests']);
    });

    it('a change with no source file has no prompt, so the report lists nothing as preloaded', () => {
      write('README.md', '# changed\n');
      commit();
      const { deps, calls } = fakes();
      runPipeline(options(), deps);
      assert.deepEqual(calls.claude, []);
      assert.deepEqual(inReport(), []);
      assert.match(artifact('report.md'), /Skills preloaded: none\. Skills invoked: none\./);
    });

    it('the report lists the transcript separately, so a skipped skill shows', () => {
      changeSource();
      const { deps } = fakes();
      runPipeline(options(), deps);
      const report = JSON.parse(artifact('report-input.json'));
      assert.deepEqual(report.preloaded_skills, ['pr-change-analysis', 'backend-unit-tests']);
      assert.deepEqual(report.invoked_skills, ['backend-unit-tests']);
    });

    it('a dry run shows what would be preloaded', () => {
      const { deps, calls } = fakes();
      runPipeline(options({ base: undefined, files: ['backend/src/a.ts'], dryRun: true }), deps);
      assert.ok(calls.logs.includes('Skills preloaded: pr-change-analysis, backend-unit-tests'));
    });
  });

  describe('feedback', () => {
    const TEXT = 'The test uses a fixed port.\n';
    const feedbackFile = (content = TEXT) => {
      const path = join(root, `feedback-${Math.random().toString(16).slice(2)}.txt`);
      writeFileSync(path, content);
      return path;
    };

    it('reaches the agent in a data tag, and a copy stays in the artifacts', () => {
      const { deps, calls } = fakes();
      runPipeline(options({ base: undefined, files: ['backend/src/a.ts'], feedback: feedbackFile() }), deps);
      assert.match(calls.claude[0][1], /<untrusted-feedback-[0-9a-f]+>\nThe test uses a fixed port\./);
      assert.equal(artifact('feedback.txt'), TEXT);
      assert.equal(artifact('prompt.txt'), calls.claude[0][1]);
    });

    it('works on a diff run too, which is what a repair round in CI uses', () => {
      changeSource();
      const { deps, calls } = fakes();
      runPipeline(options({ feedback: feedbackFile() }), deps);
      assert.match(calls.claude[0][1], /<untrusted-analysis-[0-9a-f]+>/);
      assert.match(calls.claude[0][1], /<untrusted-feedback-[0-9a-f]+>/);
    });

    it('leaves no trace in a run without it', () => {
      changeSource();
      const { deps, calls } = fakes();
      runPipeline(options(), deps);
      assert.doesNotMatch(calls.claude[0][1], /untrusted-feedback/);
      assert.equal(existsSync(join(repo, ARTIFACTS_DIR, 'feedback.txt')), false);
    });

    for (const [name, path, message] of [
      ['a missing file', () => join(root, 'no-such-file.txt'), /Cannot read the feedback file .*ENOENT/],
      ['an empty file', () => feedbackFile(' \n'), /feedback file is empty/],
    ]) {
      it(`refuses ${name} before spending anything`, () => {
        const { deps, calls } = fakes();
        assert.throws(() => runPipeline(options({ base: undefined, files: ['backend/src/a.ts'], feedback: path() }), deps), message);
        assert.deepEqual(calls.claude, []);
        assert.deepEqual(calls.baseline, []);
      });
    }

    it('a dry run reports its size and starts nothing', () => {
      const { deps, calls } = fakes();
      runPipeline(options({ base: undefined, files: ['backend/src/a.ts'], feedback: feedbackFile(), dryRun: true }), deps);
      assert.ok(calls.logs.includes(`Feedback: ${TEXT.length} characters`));
      assert.deepEqual(calls.claude, []);
    });
  });

  it('does not start the agent when the analysis says it is not needed', () => {
    write('README.md', '# changed\n');
    commit();
    const { deps, calls } = fakes();
    const result = runPipeline(options(), deps);
    assert.equal(result.outcome, 'skipped');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls.claude, []);
    assert.deepEqual(calls.baseline, []);
    assert.match(artifact('report.md'), /Only documentation changed/);
  });

  it('refuses a dirty working tree before spending anything', () => {
    changeSource();
    write('backend/src/a.ts', 'export const a = 3;\n');
    const { deps, calls } = fakes();
    assert.throws(() => runPipeline(options(), deps), /working tree has changes/);
    assert.deepEqual(calls.claude, []);
    assert.deepEqual(calls.baseline, []);
  });

  it('refuses a Claude Code version that would let tools through a broken hook', () => {
    changeSource();
    const { deps, calls } = fakes({ version: () => '2.1.227 (Claude Code)' });
    assert.throws(() => runPipeline(options(), deps), /2\.1\.295 or later/);
    assert.deepEqual(calls.claude, []);
  });

  it('refuses when Claude Code is not installed', () => {
    changeSource();
    const { deps } = fakes({ version: () => null });
    assert.throws(() => runPipeline(options(), deps), /found: none/);
  });

  it('a dry run needs no agent, no tests and no version check', () => {
    changeSource();
    const { deps, calls } = fakes({ version: () => assert.fail('no version check in a dry run') });
    const result = runPipeline(options({ dryRun: true }), deps);
    assert.equal(result.outcome, 'dry_run');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(calls.claude, []);
    assert.deepEqual(calls.baseline, []);
    assert.deepEqual(calls.verify, []);
    const text = calls.logs.join('\n');
    assert.match(text, /source_changed/);
    assert.match(text, /backend\/src\/a\.ts/);
    assert.match(text, /did not run/);
    assert.ok(!existsSync(join(repo, ARTIFACTS_DIR)));
  });

  it('a dry run works on a dirty working tree', () => {
    write('README.md', '# dirty\n');
    const { deps } = fakes();
    assert.equal(runPipeline(options({ dryRun: true }), deps).outcome, 'dry_run');
  });

  it('removes Bash with noBash', () => {
    changeSource();
    const { deps, calls } = fakes();
    runPipeline(options({ noBash: true }), deps);
    assert.ok(calls.claude[0].includes('--disallowedTools'));
  });

  it('reports a failure of the agent and does not run the gate', () => {
    changeSource();
    const { deps, calls } = fakes({
      claude: ({ transcriptPath }) => {
        writeFileSync(transcriptPath, JSON.stringify({ type: 'result', subtype: 'error_max_turns', num_turns: 5 }));
        return { status: 1, timedOut: false, startError: null };
      },
    });
    const result = runPipeline(options(), deps);
    assert.equal(result.outcome, 'agent_failed');
    assert.equal(result.conclusion, 'neutral');
    assert.equal(result.exitCode, 1);
    assert.deepEqual(calls.verify, []);
    assert.match(artifact('report.md'), /turn limit/);
  });

  it('reports a crash with no transcript at all', () => {
    changeSource();
    const { deps } = fakes({ claude: () => ({ status: null, timedOut: false, startError: 'spawn claude ENOENT' }) });
    const result = runPipeline(options(), deps);
    assert.equal(result.outcome, 'agent_failed');
    assert.match(artifact('report.md'), /could not start/);
    assert.doesNotMatch(artifact('report.md'), /turns|\$0\.0000/);
  });

  it('reports a rejection by the gate and exits with 1', () => {
    changeSource();
    const { deps } = fakes({
      verify: () => ({ status: 'failed', changed_files: [{ path: TEST_FILE, class: 'test' }], existing_tests_changed: [], shared_test_support: [], packages: {}, failures: [{ check: 'new-tests', message: '1 test(s) failed in every run.' }] }),
    });
    const result = runPipeline(options(), deps);
    assert.equal(result.outcome, 'tests_rejected');
    assert.equal(result.conclusion, 'neutral');
    assert.equal(result.exitCode, 1);
    assert.match(artifact('report.md'), /Tests rejected by the gate/);
    assert.equal(JSON.parse(artifact('verify.json')).status, 'failed');
  });

  it('adds tests for given files, with no diff', () => {
    const { deps, calls } = fakes();
    const result = runPipeline(options({ base: undefined, files: ['backend/src/a.ts'] }), deps);
    assert.equal(result.outcome, 'tests_added');
    assert.deepEqual(calls.baseline[0].packages, ['backend']);
    assert.deepEqual(calls.verify[0].sourceFiles, ['backend/src/a.ts']);
    assert.equal(calls.verify[0].mergeBase, undefined);
    assert.match(calls.claude[0][1], /<untrusted-files-[0-9a-f]+>\nbackend\/src\/a\.ts\n/);
  });

  for (const [name, files, expected] of [
    ['a file that does not exist', ['backend/src/none.ts'], /No such file/],
    ['a file that is not source', ['README.md'], /Not a source file/],
    ['a path that leaves the repository', ['../../etc/passwd'], /Not a source file/],
  ]) {
    it(`refuses ${name}`, () => {
      const { deps, calls } = fakes();
      assert.throws(() => runPipeline(options({ base: undefined, files }), deps), expected);
      assert.deepEqual(calls.claude, []);
    });
  }

  it('clears the artifacts of an earlier run', () => {
    changeSource();
    write(`${ARTIFACTS_DIR}/old.json`, '{}');
    const { deps } = fakes();
    runPipeline(options(), deps);
    assert.ok(!existsSync(join(repo, ARTIFACTS_DIR, 'old.json')));
  });

  describe('mutation check and repair rounds', () => {
    const mutant = (overrides = {}) => ({ path: 'backend/src/a.ts', line: 1, status: 'Survived', mutator: 'ConditionalExpression', original: 'a > 0', replacement: 'true', data_only: false, ...overrides });
    const mutationWith = (...mutants) => ({ schema_version: 1, status: 'completed', reason: null, skipped_paths: [], packages: { backend: { status: 'completed', total: 2, caught: 2 - mutants.length, survived: mutants.length, no_coverage: 0, errors: 0 } }, mutants });
    const accepted = { schema_version: 1, status: 'passed', changed_files: [{ path: TEST_FILE, class: 'test' }], existing_tests_changed: [], shared_test_support: [], packages: {}, failures: [] };
    const rejected = { ...accepted, status: 'failed', failures: [{ check: 'typecheck', package: 'backend', message: 'The package does not typecheck.', log: 'TS2345 in a.test.ts' }] };
    /** Each attempt gets the next answer, and the last one repeats. */
    const inOrder = (...answers) => {
      let index = 0;
      return () => structuredClone(answers[Math.min(index++, answers.length - 1)]);
    };

    it('runs after an accepted run, on the same files and merge base as the gate', () => {
      changeSource();
      const { deps, calls } = fakes();
      runPipeline(options(), deps);
      assert.deepEqual(calls.mutate[0].sourceFiles, ['backend/src/a.ts']);
      assert.equal(calls.mutate[0].mergeBase, calls.verify[0].mergeBase);
      assert.equal(JSON.parse(artifact('mutation.json')).status, 'completed');
    });

    it('does not run after a rejection, because a red test proves nothing about mutants', () => {
      changeSource();
      const { deps, calls } = fakes({ verify: inOrder(rejected) });
      runPipeline(options(), deps);
      assert.deepEqual(calls.mutate, []);
    });

    it('does not run with noMutation', () => {
      changeSource();
      const { deps, calls } = fakes();
      assert.equal(runPipeline(options({ noMutation: true }), deps).outcome, 'tests_added');
      assert.deepEqual(calls.mutate, []);
    });

    it('survivors alone never reject tests or block the check', () => {
      changeSource();
      const { deps, calls } = fakes({ mutate: () => mutationWith(mutant()) });
      const result = runPipeline(options(), deps);
      assert.equal(result.outcome, 'tests_added');
      assert.equal(result.conclusion, 'success');
      assert.equal(result.exitCode, 0);
      assert.equal(calls.claude.length, 1);
      assert.match(artifact('report.md'), /`a > 0` became `true`/);
    });

    it('by default leaves survivors as a warning, even with repair rounds allowed', () => {
      changeSource();
      const { deps, calls } = fakes({ mutate: () => mutationWith(mutant()) });
      const result = runPipeline(options({ repairRounds: 2 }), deps);
      assert.equal(calls.claude.length, 1);
      assert.equal(result.outcome, 'tests_added');
      assert.equal(result.exitCode, 0);
      assert.match(artifact('report.md'), /`a > 0` became `true`/);
      assert.doesNotMatch(artifact('report.md'), /repair round/);
    });

    it('with mutationRepair, gives survivors to the agent in a data tag, and then stops', () => {
      changeSource();
      const { deps, calls } = fakes({ mutate: inOrder(mutationWith(mutant()), mutationWith(mutant({ line: 2 }))) });
      const result = runPipeline(options({ repairRounds: 2, mutationRepair: true }), deps);
      assert.equal(calls.claude.length, 2);
      const prompt = calls.claude[1][1];
      assert.match(prompt, /<untrusted-feedback-[0-9a-f]+>[\s\S]*backend\/src\/a\.ts:1: `a > 0` became `true`[\s\S]*<\/untrusted-feedback-/);
      assert.match(prompt, /are in the working tree/);
      assert.equal(result.outcome, 'tests_added');
      assert.match(artifact('report.md'), /1 repair round\b/);
      assert.match(artifact('report.md'), /a\.ts:2/);
    });

    it('checks the repair round again with the gate and the mutation check', () => {
      changeSource();
      const { deps, calls } = fakes({ mutate: inOrder(mutationWith(mutant()), mutationWith()) });
      runPipeline(options({ repairRounds: 2, mutationRepair: true }), deps);
      assert.equal(calls.verify.length, 2);
      assert.ok(existsSync(join(repo, ARTIFACTS_DIR, 'mutation.round-1.json')));
      assert.equal(JSON.parse(artifact('report-input.json')).mutation.mutants.length, 0);
    });

    it('keeps the artifacts of each attempt apart', () => {
      changeSource();
      const { deps } = fakes({ mutate: inOrder(mutationWith(mutant()), mutationWith()) });
      runPipeline(options({ repairRounds: 1, mutationRepair: true }), deps);
      for (const name of ['prompt.round-1.txt', 'feedback.round-1.txt', 'transcript.round-1.jsonl', 'result.round-1.json', 'verify.round-1.json', 'mutation.round-1.json']) {
        assert.ok(existsSync(join(repo, ARTIFACTS_DIR, name)), name);
      }
      assert.equal(JSON.parse(artifact('mutation.json')).mutants.length, 1);
    });

    it('adds up the cost and turns of all attempts', () => {
      changeSource();
      const { deps } = fakes({ mutate: inOrder(mutationWith(mutant()), mutationWith()) });
      runPipeline(options({ repairRounds: 1, mutationRepair: true }), deps);
      assert.match(artifact('report.md'), /14 turns/);
      assert.match(artifact('report.md'), /\$0\.5000/);
      assert.match(artifact('report.md'), /2 blocked tool calls/);
    });

    it('gives a rejection to the agent with the log, and accepts a good repair', () => {
      changeSource();
      const { deps, calls } = fakes({ verify: inOrder(rejected, accepted) });
      const result = runPipeline(options({ repairRounds: 1 }), deps);
      assert.equal(result.outcome, 'tests_added');
      assert.equal(result.exitCode, 0);
      assert.match(calls.claude[1][1], /<untrusted-feedback-[0-9a-f]+>[\s\S]*TS2345 in a\.test\.ts/);
    });

    it('stops after the allowed rounds and reports the rejection', () => {
      changeSource();
      const { deps, calls } = fakes({ verify: inOrder(rejected) });
      const result = runPipeline(options({ repairRounds: 2 }), deps);
      assert.equal(calls.claude.length, 3);
      assert.equal(result.outcome, 'tests_rejected');
      assert.equal(result.exitCode, 1);
    });

    describe('when a repair round makes accepted tests worse', () => {
      const EXISTING = 'backend/tests/old.test.ts';
      const prepare = () => {
        write(EXISTING, '// original\n');
        changeSource();
      };
      const agentThatBreaksThings = (calls, afterRepair) => ({ args, transcriptPath }) => {
        calls.push(args);
        if (calls.length === 1) {
          write(TEST_FILE, '// accepted\n');
        } else {
          write(TEST_FILE, '// worse\n');
          write(EXISTING, '// damaged\n');
          write('backend/tests/extra.test.ts', '// extra\n');
        }
        const final = calls.length === 1 ? { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.1, structured_output: validResult() } : afterRepair;
        writeFileSync(transcriptPath, JSON.stringify(final));
        return { status: 0, timedOut: false, startError: null };
      };
      const expectAcceptedTree = () => {
        assert.equal(readFileSync(join(repo, TEST_FILE), 'utf8'), '// accepted\n');
        assert.equal(readFileSync(join(repo, EXISTING), 'utf8'), '// original\n');
        assert.equal(existsSync(join(repo, 'backend/tests/extra.test.ts')), false);
      };

      it('keeps the accepted tests after the gate rejects the repair', () => {
        prepare();
        const claudeCalls = [];
        const { deps } = fakes({
          claude: agentThatBreaksThings(claudeCalls, { type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.1, structured_output: validResult() }),
          verify: inOrder(accepted, rejected),
          mutate: inOrder(mutationWith(mutant())),
        });
        const result = runPipeline(options({ repairRounds: 1, mutationRepair: true }), deps);
        expectAcceptedTree();
        assert.equal(result.outcome, 'tests_added');
        assert.equal(result.exitCode, 0);
        assert.match(artifact('report.md'), /tests accepted earlier were kept/);
        assert.match(artifact('report.md'), /`a > 0` became `true`/);
      });

      it('keeps the accepted tests after the agent fails in the repair', () => {
        prepare();
        const claudeCalls = [];
        const { deps } = fakes({
          claude: agentThatBreaksThings(claudeCalls, { type: 'result', subtype: 'error_max_turns', num_turns: 1 }),
          mutate: inOrder(mutationWith(mutant())),
        });
        const result = runPipeline(options({ repairRounds: 1, mutationRepair: true }), deps);
        expectAcceptedTree();
        assert.equal(result.outcome, 'tests_added');
        assert.match(artifact('report.md'), /turn limit/);
      });
    });
  });

  it('exits with 2 and a readable message from the command line', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^test-agent: Pass either/);
  });

  it('a dry run from the command line works with no API key', () => {
    changeSource();
    const { ANTHROPIC_API_KEY: _key, CLAUDE_CODE_OAUTH_TOKEN: _token, ...env } = process.env;
    const result = spawnSync(process.execPath, [SCRIPT, '--base', 'main', '--dry-run'], { cwd: repo, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /did not run/);
    assert.doesNotMatch(result.stdout, /<untrusted-/);
  });
});
