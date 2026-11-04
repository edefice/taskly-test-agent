import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readTranscript } from './read-transcript.mjs';
import { conclusionFor, MAX_REPORT_LENGTH, REPORT_MARKER, renderReport, safeCode, safeText, SOURCE_NOTE } from './render-report.mjs';
import { AGENT_RESULT_SCHEMA, crossCheckWithVerification, readResultFile, validateAgainstSchema, validateResult } from './validate-result.mjs';

const VALIDATE = fileURLToPath(new URL('./validate-result.mjs', import.meta.url));
const RENDER = fileURLToPath(new URL('./render-report.mjs', import.meta.url));
const TEST_FILE = 'backend/tests/health.test.ts';

const validResult = (overrides = {}) => ({
  decision: 'tests_added',
  reasoning: 'The health route had no tests.',
  skills_used: ['pr-change-analysis', 'backend-unit-tests'],
  files: [{ path: TEST_FILE, action: 'created' }],
  tests: [{ file: TEST_FILE, name: 'reports ok', behavior: 'The health route answers ok after a query succeeds.' }],
  existing_tests_changed: [],
  suspected_bugs: [],
  regressions: [],
  ...overrides,
});

const noTests = (overrides = {}) => validResult({ decision: 'no_tests_needed', files: [], tests: [], ...overrides });

let directory;
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'pr-report-'));
});
after(() => rmSync(directory, { recursive: true, force: true }));

describe('validateResult: schema', () => {
  it('accepts a valid result', () => {
    assert.deepEqual(validateResult(validResult()), []);
  });

  it('accepts a decision to write no tests', () => {
    assert.deepEqual(validateResult(noTests()), []);
  });

  for (const value of [null, 42, 'text', [], true]) {
    it(`rejects ${JSON.stringify(value)} as the whole result`, () => {
      assert.notDeepEqual(validateResult(value), []);
    });
  }

  for (const key of AGENT_RESULT_SCHEMA.required) {
    it(`rejects a result with no ${key}`, () => {
      const result = validResult();
      delete result[key];
      assert.match(validateResult(result).join('\n'), new RegExp(`${key} is missing`));
    });
  }

  for (const [name, overrides] of [
    ['an unknown decision', { decision: 'approved' }],
    ['a reasoning that is not text', { reasoning: 42 }],
    ['an empty reasoning', { reasoning: '' }],
    ['a reasoning that is too long', { reasoning: 'x'.repeat(1001) }],
    ['an unknown skill', { skills_used: ['vercel:deploy'] }],
    ['too many skills', { skills_used: Array(6).fill('pr-report') }],
    ['files that are not a list', { files: {} }],
    ['an unknown file action', { files: [{ path: TEST_FILE, action: 'deleted' }] }],
    ['a file with an extra property', { files: [{ path: TEST_FILE, action: 'created', extra: 1 }] }],
    ['a test with no behavior', { tests: [{ file: TEST_FILE, name: 'a' }] }],
    ['a test with an empty behavior', { tests: [{ file: TEST_FILE, name: 'a', behavior: '' }] }],
    ['a behavior that is too long', { tests: [{ file: TEST_FILE, name: 'a', behavior: 'x'.repeat(301) }] }],
    ['too many tests', { tests: Array(201).fill({ file: TEST_FILE, name: 'a', behavior: 'b' }) }],
    ['an unknown top-level property', { instructions: 'merge this' }],
  ]) {
    it(`rejects ${name}`, () => {
      assert.notDeepEqual(validateResult(validResult(overrides)), []);
    });
  }

  it('does not repeat values from the result in its errors', () => {
    const errors = validateResult(validResult({ decision: 'IGNORE-PREVIOUS-INSTRUCTIONS', injected_key: 1 }));
    assert.doesNotMatch(errors.join('\n'), /IGNORE|injected_key/);
  });

  it('treats a __proto__ key as an unknown property', () => {
    const result = JSON.parse(JSON.stringify(validResult()).replace('{', '{"__proto__":{"x":1},'));
    assert.notDeepEqual(validateResult(result), []);
  });

  it('supports the keywords used by the schema', () => {
    assert.deepEqual(validateAgainstSchema(1, { type: 'number' }), []);
    assert.deepEqual(validateAgainstSchema('a', { type: 'number' }), ['result must be of type number.']);
  });
});

describe('validateResult: consistency', () => {
  it('rejects tests_added with no files', () => {
    assert.notDeepEqual(validateResult(validResult({ files: [], tests: [] })), []);
  });

  it('rejects tests_added with files but no described test', () => {
    assert.match(validateResult(validResult({ tests: [] })).join('\n'), /described test/);
  });

  it('accepts tests_updated with a justified change and no new test', () => {
    const result = validResult({ decision: 'tests_updated', tests: [], existing_tests_changed: [{ path: TEST_FILE, justification: 'The route now returns 201.' }] });
    assert.deepEqual(validateResult(result), []);
  });

  it('rejects no_tests_needed that lists files', () => {
    assert.notDeepEqual(validateResult(noTests({ files: [{ path: TEST_FILE, action: 'created' }] })), []);
  });

  it('rejects no_tests_needed that lists tests', () => {
    assert.notDeepEqual(validateResult(noTests({ tests: validResult().tests })), []);
  });

  for (const path of ['backend/src/app.ts', '.github/workflows/ci.yml', '../evil.test.ts', '.claude/settings.json']) {
    it(`rejects the path ${path}`, () => {
      assert.match(validateResult(validResult({ files: [{ path, action: 'created' }], tests: [] })).join('\n'), /allowlist/);
    });
  }

  it('rejects a test in a file that is not listed', () => {
    const tests = [{ file: 'backend/tests/other.test.ts', name: 'a', behavior: 'b' }];
    assert.match(validateResult(validResult({ tests })).join('\n'), /not listed/);
  });

  it('rejects a justification for a file that is not listed', () => {
    const existing = [{ path: 'backend/tests/other.test.ts', justification: 'x' }];
    assert.match(validateResult(validResult({ existing_tests_changed: existing })).join('\n'), /not listed/);
  });
});

describe('crossCheckWithVerification', () => {
  const verification = (overrides = {}) => ({ changed_files: [{ path: TEST_FILE, class: 'test' }], existing_tests_changed: [], ...overrides });

  it('accepts a result that matches the working tree', () => {
    assert.deepEqual(crossCheckWithVerification(validResult(), verification()), []);
  });

  it('rejects a changed file the agent did not mention', () => {
    const changed = [{ path: TEST_FILE, class: 'test' }, { path: 'backend/tests/fixture.ts', class: 'shared-test-support' }];
    assert.match(crossCheckWithVerification(validResult(), verification({ changed_files: changed })).join('\n'), /not listed in the result/);
  });

  it('rejects a file the agent claims but did not change', () => {
    assert.match(crossCheckWithVerification(validResult(), verification({ changed_files: [] })).join('\n'), /did not change/);
  });

  it('rejects a test file with no described test', () => {
    const errors = crossCheckWithVerification(validResult({ tests: [] }), verification());
    assert.match(errors.join('\n'), /no test described/);
  });

  it('accepts a new test described under its exact title', () => {
    const report = verification({ new_tests: [{ path: TEST_FILE, title: 'reports ok' }] });
    assert.deepEqual(crossCheckWithVerification(validResult(), report), []);
  });

  it('rejects a new test with no entry of its own, so tests cannot be grouped', () => {
    const report = verification({ new_tests: [{ path: TEST_FILE, title: 'reports ok' }, { path: TEST_FILE, title: 'reports a failure' }] });
    assert.match(crossCheckWithVerification(validResult(), report).join('\n'), /1 new test\(s\) have no entry/);
  });

  it('rejects a description under another file', () => {
    const report = verification({ new_tests: [{ path: 'backend/tests/other.test.ts', title: 'reports ok' }] });
    assert.match(crossCheckWithVerification(validResult(), report).join('\n'), /no entry/);
  });

  it('does not require a description for shared test support', () => {
    const path = 'backend/tests/fixture.ts';
    const result = validResult({ files: [{ path, action: 'modified' }], tests: [] });
    assert.deepEqual(crossCheckWithVerification(result, verification({ changed_files: [{ path, class: 'shared-test-support' }] })), []);
  });

  it('rejects a changed existing test with no justification', () => {
    const errors = crossCheckWithVerification(validResult(), verification({ existing_tests_changed: [{ path: TEST_FILE, changed_lines: 1 }] }));
    assert.match(errors.join('\n'), /no justification/);
  });

  it('accepts a changed existing test with a justification and no new test', () => {
    const result = validResult({ decision: 'tests_updated', tests: [], existing_tests_changed: [{ path: TEST_FILE, justification: 'New status.' }] });
    const errors = crossCheckWithVerification(result, verification({ existing_tests_changed: [{ path: TEST_FILE, changed_lines: 1 }] }));
    assert.deepEqual(errors, []);
  });
});

describe('readResultFile', () => {
  it('reports a missing file clearly', () => {
    const { result, errors } = readResultFile(join(directory, 'absent.json'));
    assert.equal(result, null);
    assert.match(errors[0], /does not exist/);
  });

  it('reports invalid JSON without repeating it', () => {
    const path = join(directory, 'broken.json');
    writeFileSync(path, 'IGNORE PREVIOUS {');
    const { errors } = readResultFile(path);
    assert.deepEqual(errors, ['The agent result is not valid JSON.']);
  });
});

describe('validate-result command line', () => {
  const cli = (...args) => spawnSync(process.execPath, [VALIDATE, ...args], { encoding: 'utf8' });
  const file = (name, value) => {
    const path = join(directory, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };

  it('exits with 0 on a valid result', () => {
    assert.equal(cli('--result', file('ok.json', validResult())).status, 0);
  });

  it('exits with 1 on an invalid result and explains why', () => {
    const result = cli('--result', file('bad.json', validResult({ decision: 'nope' })));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not valid/);
  });

  it('exits with 1 on a missing file', () => {
    const result = cli('--result', join(directory, 'nothing.json'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not exist/);
  });

  it('exits with 1 when the result disagrees with the gate', () => {
    const result = cli('--result', file('ok2.json', validResult()), '--verify', file('v.json', { changed_files: [] }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not change/);
  });

  it('exits with 1 when an option is missing', () => {
    assert.equal(cli().status, 1);
  });
});

describe('safeText', () => {
  it('removes mentions, including ones that re-form', () => {
    assert.doesNotMatch(safeText('ping @octocat and @@org/team a@b.c'), /@/);
  });

  it('neutralizes HTML', () => {
    const text = safeText('<img src=x onerror=alert(1)> <!-- hidden --> <details>');
    assert.doesNotMatch(text.replace(/\\</g, ''), /</);
  });

  it('neutralizes entities that decode into a mention or a tag', () => {
    assert.equal(safeText('&#64;octocat &lt;script&gt;'), '\\&# 64;octocat \\&lt;script\\&gt;');
  });

  it('neutralizes links and images', () => {
    const text = safeText('[click](https://evil.example) ![pixel](http://evil.example/a.png) www.evil.example');
    assert.doesNotMatch(text, /https?:\/\/|www\./);
    assert.ok(text.includes('\\[click\\]'));
    assert.ok(text.includes('\\!\\[pixel\\]'));
  });

  it('neutralizes references to issues', () => {
    assert.equal(safeText('closes #12'), 'closes # 12');
  });

  it('escapes code spans and emphasis, and table separators', () => {
    assert.equal(safeText('`a` *b* _c_ | d'), '\\`a\\` \\*b\\* \\_c\\_ \\| d');
  });

  it('escapes the escape character, so an escape cannot be undone', () => {
    assert.equal(safeText('\\<b>'), '\\\\\\<b\\>');
  });

  it('keeps everything on one line, so a heading or a list cannot start', () => {
    assert.equal(safeText('first\n# Heading\n- item\r\n\r\nlast'), 'first # Heading - item last');
  });

  it('removes control and invisible characters', () => {
    assert.equal(safeText('a\u001b[31mb\u0000c​d‮e'), 'abcde');
  });

  it('masks credentials', () => {
    assert.equal(safeText('key sk-ant-api03-abcdef'), 'key \\[REDACTED\\]');
  });

  it('limits the length', () => {
    assert.equal(safeText('x'.repeat(20), 5), 'xxxxx...');
  });

  it('accepts a missing value', () => {
    assert.equal(safeText(undefined), '');
  });
});

describe('safeCode', () => {
  it('wraps a path in a code span', () => {
    assert.equal(safeCode('backend/tests/a.test.ts'), '`backend/tests/a.test.ts`');
  });

  it('cannot be closed from inside', () => {
    assert.equal(safeCode('a` <img src=x> `b'), "`a' <img src=x> 'b`");
  });

  it('keeps a table cell intact', () => {
    assert.equal(safeCode('a|b'), '`a\\|b`');
  });

  it('keeps a name with a newline on one line', () => {
    assert.equal(safeCode('a\nb'), '`a b`');
  });

  it('masks credentials and limits the length', () => {
    assert.equal(safeCode('sk-ant-api03-abc'), '`[REDACTED]`');
    assert.equal(safeCode('x'.repeat(20), 5), '`xxxxx...`');
  });

  it('shows an empty value', () => {
    assert.equal(safeCode(''), '`(empty)`');
  });
});

describe('conclusionFor', () => {
  const regression = { regression_check: { regressions: ['backend/tests/a.test.ts > b'] } };

  for (const [outcome, expected] of [
    ['tests_added', 'success'],
    ['no_tests_needed', 'success'],
    ['tests_rejected', 'neutral'],
    ['agent_failed', 'neutral'],
    ['stale', 'neutral'],
    ['fork', 'neutral'],
  ]) {
    it(`${outcome} gives ${expected}`, () => {
      assert.equal(conclusionFor({ outcome }), expected);
    });

    it(`${outcome} with a real regression fails`, () => {
      assert.equal(conclusionFor({ outcome, ...regression }), 'failure');
    });
  }

  it('skipped with nothing to test is a success', () => {
    assert.equal(conclusionFor({ outcome: 'skipped', analysis: { decision: { reason_code: 'docs_only' } } }), 'success');
  });

  it('skipped because it is too large is neutral, since nothing was checked', () => {
    assert.equal(conclusionFor({ outcome: 'skipped', analysis: { decision: { reason_code: 'too_large' } } }), 'neutral');
  });

  it('a regression claimed by the model alone does not fail the check', () => {
    const result = validResult({ regressions: [{ test: 'a', explanation: 'b' }] });
    assert.equal(conclusionFor({ outcome: 'tests_added', result }), 'success');
  });

  it('a test that was already red does not fail the check', () => {
    assert.equal(conclusionFor({ outcome: 'tests_added', regression_check: { regressions: [], baseline_red: ['a'] } }), 'success');
  });
});

describe('renderReport', () => {
  const verification = {
    changed_files: [{ path: TEST_FILE, class: 'test' }],
    shared_test_support: [],
    failures: [],
    packages: {
      backend: {
        typecheck: { passed: true },
        new_tests: { runs: 3, passed: true, total: 2, failed: [], flaky: [] },
        full_package: { passed: true, total: 50, new_failures: [], baseline_failures: [] },
        coverage: {
          total: { before: { lines: { pct: 33.02 }, branches: { pct: 33.33 } }, after: { lines: { pct: 37.61 }, branches: { pct: 35 } } },
          files: [{ path: 'backend/src/api/health.ts', before: { lines: { pct: 0 }, branches: { pct: 100 } }, after: { lines: { pct: 100 }, branches: { pct: 100 } }, changed_lines: { total: 4, covered: 3, uncovered: [9] } }],
        },
      },
    },
  };
  const input = (overrides = {}) => ({
    outcome: 'tests_added',
    result: validResult(),
    verification,
    preloaded_skills: ['pr-change-analysis'],
    invoked_skills: ['backend-unit-tests'],
    head_sha: 'abcdef1234567890',
    commit_sha: '1234567890abcdef',
    prompt_version: '1',
    run_url: 'https://github.com/edefice/taskly-test-agent/actions/runs/1',
    usage: { model: 'claude-sonnet-5-5', turns: 12, cost_usd: 0.1234 },
    ...overrides,
  });
  const markdown = (overrides) => renderReport(input(overrides)).markdown;

  it('starts with the marker that the sticky comment is found by', () => {
    assert.ok(markdown().startsWith(`${REPORT_MARKER}\n`));
  });

  it('shows what happened first', () => {
    const lines = markdown().split('\n');
    assert.equal(lines[1], '### Unit test agent: 1 test added to this pull request');
    assert.equal(lines[3], 'The health route had no tests.');
  });

  it('shows every required fact', () => {
    const text = markdown();
    for (const expected of [
      'The health route answers ok after a query succeeds.',
      'Skills preloaded: `pr-change-analysis`. Skills invoked: `backend-unit-tests`.',
      TEST_FILE,
      '50 tests: passed',
      '2 tests, 3 runs: passed',
      '33.02%',
      '37.61%',
      'backend/src/api/health.ts',
      '| 3/4 |',
      'claude-sonnet-5-5',
      '12 turns',
      '$0.1234',
      'https://github.com/edefice/taskly-test-agent/actions/runs/1',
      '`abcdef123456`',
      '`1234567890ab`',
      'Prompt version `1`',
    ]) {
      assert.ok(text.includes(expected), `missing: ${expected}`);
    }
  });

  it('says tests were verified, not added, when nothing was committed', () => {
    assert.match(markdown({ commit_sha: undefined }), /1 test written and verified/);
  });

  it('counts tests in plain words', () => {
    const tests = [validResult().tests[0], validResult().tests[0], validResult().tests[0], validResult().tests[0]];
    assert.match(markdown({ result: validResult({ tests }) }), /### Unit test agent: 4 tests added to this pull request/);
    assert.match(markdown({ result: validResult({ tests }), commit_sha: undefined }), /4 tests written and verified/);
    assert.doesNotMatch(markdown(), /\(s\)\s+added/);
  });

  it('separates what the gate verified from what the agent claims', () => {
    assert.ok(markdown().includes(SOURCE_NOTE));
    assert.match(SOURCE_NOTE, /reported by the agent and not verified/);
    assert.match(SOURCE_NOTE, /come from the gate/);
  });

  it('has no claim to mark when the agent returned nothing', () => {
    assert.ok(!renderReport({ outcome: 'agent_failed' }).markdown.includes(SOURCE_NOTE));
  });

  it('shows both skill lists, also when a list is empty', () => {
    assert.match(markdown({ invoked_skills: [] }), /Skills preloaded: `pr-change-analysis`\. Skills invoked: none\./);
  });

  it('shows blocked tool calls, only when there are some', () => {
    assert.match(markdown({ usage: { blocked_calls: 3 } }), /3 blocked tool calls/);
    assert.match(markdown({ usage: { blocked_calls: 1 } }), /1 blocked tool call\b/);
    assert.doesNotMatch(markdown({ usage: { blocked_calls: 0 } }), /blocked tool calls/);
  });

  it('explains a deliberate decision to write no tests', () => {
    const report = renderReport(input({ outcome: 'no_tests_needed', result: noTests({ reasoning: 'Only a comment changed.' }), verification: undefined, commit_sha: undefined }));
    assert.match(report.markdown, /No tests needed/);
    assert.match(report.markdown, /Only a comment changed\./);
    assert.equal(report.conclusion, 'success');
  });

  it('explains why the agent did not run', () => {
    const analysis = { decision: { reason_code: 'docs_only', reason: 'Only documentation changed.' }, flags: { symlinks: [] } };
    const text = markdown({ outcome: 'skipped', analysis, result: undefined, verification: undefined });
    assert.match(text, /Only documentation changed\./);
  });

  it('explains a failure of the agent and says it does not block', () => {
    const report = renderReport(input({ outcome: 'agent_failed', failure_reason: 'The agent reached the turn limit.', result: undefined, verification: undefined }));
    assert.match(report.markdown, /could not finish, nothing was committed/);
    assert.match(report.markdown, /turn limit/);
    assert.match(report.markdown, /does not block/);
    assert.match(report.markdown, /actions\/runs\/1/);
    assert.equal(report.conclusion, 'neutral');
  });

  it('lists gate failures without the log or the failure messages', () => {
    const failures = [
      { check: 'new-tests', package: 'backend', message: '1 test(s) failed in every run.', tests: [{ id: 'backend/tests/a.test.ts > b', message: 'SECRET-LOG-CONTENT' }] },
      { check: 'test-rules', message: '1 rule violation(s).', violations: [{ rule: 'focused-or-skipped-test', path: TEST_FILE, line: 2, message: 'x' }] },
      { check: 'scope', message: '1 changed path(s).', paths: [{ path: 'backend/src/a.ts', reason: 'is outside the test allowlist' }] },
      { check: 'typecheck', package: 'backend', message: 'The package does not typecheck.', log: 'RAW-LOG-CONTENT' },
    ];
    const report = renderReport(input({ outcome: 'tests_rejected', commit_sha: undefined, verification: { ...verification, failures } }));
    assert.match(report.markdown, /Tests rejected by the gate, nothing was committed/);
    for (const expected of ['backend/tests/a.test.ts > b', 'focused-or-skipped-test', 'backend/src/a.ts', 'does not typecheck']) {
      assert.ok(report.markdown.includes(expected), `missing: ${expected}`);
    }
    assert.doesNotMatch(report.markdown, /SECRET-LOG-CONTENT|RAW-LOG-CONTENT/);
    assert.equal(report.conclusion, 'neutral');
  });

  it('puts a real regression at the top and fails the check', () => {
    const report = renderReport(input({ regression_check: { regressions: ['backend/tests/router.test.ts > lists tasks'] } }));
    assert.equal(report.conclusion, 'failure');
    const text = report.markdown;
    assert.ok(text.indexOf('Regression') < text.indexOf('New tests'));
    assert.ok(text.includes('backend/tests/router.test.ts > lists tasks'));
  });

  it('separates shared test support changes', () => {
    const text = markdown({ verification: { ...verification, shared_test_support: ['frontend/src/design-system/mocks.tsx'] } });
    assert.match(text, /#### Shared test support changed \(the whole package ran\)\n\n- `frontend\/src\/design-system\/mocks\.tsx`/);
  });

  it('shows the justification of a changed existing test', () => {
    const text = markdown({ result: validResult({ existing_tests_changed: [{ path: TEST_FILE, justification: 'The route now returns 201.' }] }) });
    assert.match(text, /Existing tests changed/);
    assert.match(text, /The route now returns 201\./);
  });

  it('shows suspected bugs', () => {
    const text = markdown({ result: validResult({ suspected_bugs: [{ file: 'backend/src/a.ts', expected: '404', actual: '500' }] }) });
    assert.match(text, /Possible bugs reported by the agent\n\n- `backend\/src\/a\.ts`: expected 404, actual 500/);
  });

  it('separates tests that were already red', () => {
    const packages = { backend: { ...verification.packages.backend, full_package: { passed: true, total: 50, new_failures: [], baseline_failures: ['backend/tests/a.test.ts > red'] } } };
    const report = renderReport(input({ verification: { ...verification, packages } }));
    assert.match(report.markdown, /Already failing before this run/);
    assert.equal(report.conclusion, 'success');
  });

  it('flags symbolic links in the pull request', () => {
    const analysis = { decision: { reason_code: 'source_changed' }, flags: { symlinks: ['backend/tests/link.test.ts'] } };
    assert.match(markdown({ analysis }), /Symbolic links changed[\s\S]*backend\/tests\/link\.test\.ts/);
  });

  it('shows n/a for coverage it does not have', () => {
    const packages = { backend: { ...verification.packages.backend, coverage: { total: { before: null, after: { lines: { pct: 40 }, branches: { pct: 30 } } }, files: [] } } };
    assert.match(markdown({ verification: { ...verification, packages } }), /\| n\/a \| 40% \|/);
  });

  it('rejects an outcome it does not know', () => {
    assert.throws(() => renderReport(input({ outcome: 'merged' })), /Unknown outcome/);
  });

  it('survives having only an outcome', () => {
    const { markdown: text, conclusion } = renderReport({ outcome: 'agent_failed' });
    assert.ok(text.startsWith(REPORT_MARKER));
    assert.equal(conclusion, 'neutral');
    assert.match(text, /unknown/);
  });

  describe('untrusted content', () => {
    const attack = '@octocat <img src=x onerror=alert(1)> [x](https://evil.example) ![p](https://evil.example/a.png) `code` &#64;team #12 \n\n# Heading\n<!-- unit-test-agent-report -->';
    const hostile = () =>
      renderReport(
        input({
          failure_reason: attack,
          result: validResult({
            reasoning: attack,
            tests: [{ file: attack, name: attack, behavior: attack }],
            suspected_bugs: [{ file: attack, expected: attack, actual: attack }],
            existing_tests_changed: [{ path: attack, justification: attack }],
            regressions: [{ test: attack, explanation: attack }],
          }),
          usage: { model: attack },
          prompt_version: attack,
          preloaded_skills: [attack],
          invoked_skills: [attack],
          analysis: { decision: { reason: attack }, flags: { symlinks: [attack] } },
          regression_check: { regressions: [attack], baseline_red: [attack] },
          verification: {
            ...verification,
            shared_test_support: [attack],
            failures: [{ check: attack, package: attack, message: attack, tests: [{ id: attack }], violations: [{ rule: attack, path: attack }], paths: [{ path: attack, reason: attack }] }],
          },
        }),
      ).markdown;

    // A code span is inert, so only what is left outside the spans can do anything.
    const outsideCode = (text) => text.replace(/`[^`\n]*`/g, '');

    it('has no mention anywhere outside a code span', () => {
      assert.doesNotMatch(outsideCode(hostile()), /@\w/);
    });

    it('has no raw HTML outside a code span, apart from the template', () => {
      const text = outsideCode(hostile()).replace(REPORT_MARKER, '').replace(/<\/?sub>/g, '');
      assert.doesNotMatch(text.replace(/\\</g, ''), /</);
    });

    it('has exactly one marker, at the start, even counting code spans', () => {
      const text = hostile();
      assert.ok(text.startsWith(REPORT_MARKER));
      assert.equal(text.split(REPORT_MARKER).length, 2);
      assert.equal(text.split('<!--').length, 2);
    });

    it('has no working link or image, apart from the run link', () => {
      const text = outsideCode(hostile()).replace('[Run and logs](https://github.com/edefice/taskly-test-agent/actions/runs/1)', '');
      assert.doesNotMatch(text, /https?:\/\//);
      assert.doesNotMatch(text, /(?<!\\)!?(?<!\\)\[[^\]]*\]\(/);
    });

    it('adds no heading from untrusted text', () => {
      const headings = hostile().split('\n').filter((line) => /^#{1,6} /.test(line));
      assert.ok(headings.every((line) => line.startsWith('### Unit test agent:') || line.startsWith('#### ')), headings.join('\n'));
      assert.equal(headings.filter((line) => line.includes('Heading')).length, 0);
    });

    it('does not break out of a code span', () => {
      for (const line of hostile().split('\n')) {
        assert.equal(((line.replace(/\\`/g, '').match(/`/g) ?? []).length) % 2, 0, line);
      }
    });

    for (const url of [
      'https://x.example/a) [evil](https://evil.example',
      'https://evil.example/o/r/actions/runs/1',
      'https://github.com/o/r/actions/runs/1) [evil](https://evil.example',
      'https://github.com/o/r/pull/1',
      'http://github.com/o/r/actions/runs/1',
      'javascript:alert(1)',
      42,
    ]) {
      it(`does not turn ${JSON.stringify(url)} into a link`, () => {
        const text = markdown({ run_url: url });
        assert.doesNotMatch(text, /\]\(/);
        assert.doesNotMatch(text, /evil/);
      });
    }

    it('links a real run, also one with an attempt', () => {
      assert.match(markdown({ run_url: 'https://github.com/o/r/actions/runs/1/attempts/2' }), /\[Run and logs\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\/attempts\/2\)/);
    });
  });

  it('limits long lists', () => {
    const tests = Array.from({ length: 200 }, (_, index) => ({ file: TEST_FILE, name: `t${index}`, behavior: 'b' }));
    const text = markdown({ result: validResult({ tests }) });
    assert.match(text, /and 170 more/);
    assert.doesNotMatch(text, /`t30`/);
  });

  it('limits the total length under the GitHub comment limit', () => {
    const big = 'x'.repeat(300);
    const list = Array.from({ length: 30 }, () => big);
    const failures = Array.from({ length: 30 }, () => ({ check: big, message: big, tests: Array.from({ length: 10 }, () => ({ id: big })) }));
    const shared = list;
    const report = renderReport(input({ verification: { ...verification, failures, shared_test_support: shared }, regression_check: { regressions: list, baseline_red: list.map((v, i) => `${v}${i}`) } }));
    assert.ok(report.markdown.length <= MAX_REPORT_LENGTH + 100);
    assert.ok(report.markdown.length < 65536);
  });
});

describe('renderReport: mutation check', () => {
  const base = { outcome: 'tests_added', result: validResult(), head_sha: 'abc', usage: {} };
  const mutant = (overrides = {}) => ({ path: 'backend/src/a.ts', line: 7, status: 'Survived', mutator: 'ConditionalExpression', original: 'a > 0', replacement: 'true', data_only: false, ...overrides });
  const completed = (mutants, entry = {}) => ({ status: 'completed', reason: null, skipped_paths: [], packages: { backend: { status: 'completed', total: 10, caught: 10 - mutants.length, survived: mutants.length, no_coverage: 0, errors: 0, ...entry } }, mutants });
  const render = (mutation, extra = {}) => renderReport({ ...base, mutation, ...extra }).markdown;

  it('has no section without a result', () => {
    assert.doesNotMatch(render(undefined), /Mutation check/);
  });

  it('gives the counts per package', () => {
    assert.match(render(completed([mutant()])), /`backend`: 9 of 10 changes to the changed lines made a test fail, 1 did not\./);
  });

  it('counts code no test runs as missed', () => {
    assert.match(render(completed([mutant({ status: 'NoCoverage' })], { survived: 0, no_coverage: 1 })), /9 of 10 .* 1 did not/);
  });

  it('lists what no test noticed, with the place and the change, as a warning', () => {
    const markdown = render(completed([mutant()]));
    assert.match(markdown, /`backend\/src\/a\.ts:7`: `a > 0` became `true`/);
    assert.match(markdown, /does not block the pull request/);
  });

  it('has no warning when every change was caught', () => {
    assert.doesNotMatch(render(completed([])), /does not block/);
  });

  it('never changes the check result', () => {
    assert.equal(renderReport({ ...base, mutation: completed([mutant()]) }).conclusion, 'success');
    assert.equal(renderReport({ ...base, mutation: { status: 'incomplete', packages: { backend: { status: 'failed' } }, mutants: [] } }).conclusion, 'success');
  });

  it('counts data mutants and does not list them', () => {
    const markdown = render(completed([mutant({ data_only: true, original: 'a label' })]));
    assert.doesNotMatch(markdown, /a label/);
    assert.match(markdown, /1 more changed only text or data/);
  });

  it('caps the list', () => {
    const markdown = render(completed(Array.from({ length: 13 }, (_, line) => mutant({ line }))));
    assert.equal((markdown.match(/ became /g) ?? []).length, 10);
    assert.match(markdown, /and 3 more, see the run artifact/);
  });

  it('says when it was skipped and why', () => {
    assert.match(render({ status: 'skipped', reason: 'The change has 500 changed source lines.', packages: {}, mutants: [] }), /Not run\. The change has 500/);
  });

  it('says when a package did not finish, without a log from the branch', () => {
    const markdown = render({ status: 'incomplete', packages: { backend: { status: 'timed_out' }, frontend: { status: 'failed', log: 'secret log text' } }, mutants: [] });
    assert.match(markdown, /`backend` hit the time limit/);
    assert.match(markdown, /`frontend` could not run/);
    assert.doesNotMatch(markdown, /secret log text/);
  });

  it('names files it left out', () => {
    assert.match(render({ ...completed([]), skipped_paths: ['backend/src/a b.ts'] }), /unusual file names: `backend\/src\/a b\.ts`/);
  });

  it('makes code from the branch safe', () => {
    const markdown = render(completed([mutant({ original: '`<img src=x> @someone', replacement: '<!-- -->|' })]));
    assert.doesNotMatch(markdown, /<!-- -->/);
    assert.match(markdown, /'<img src=x> @someone/);
    assert.ok(markdown.split('<!-- unit-test-agent-report -->').length === 2);
  });

  it('shows repair rounds and why earlier tests were kept', () => {
    const markdown = render(undefined, { repair_rounds: 1, repair_note: 'The gate rejected a repair round, so the tests accepted earlier were kept.' });
    assert.match(markdown, /1 repair round\b/);
    assert.match(markdown, /tests accepted earlier were kept/);
    assert.match(render(undefined, { repair_rounds: 2 }), /2 repair rounds/);
    assert.doesNotMatch(render(undefined, { repair_rounds: 0 }), /repair round/);
  });
});

describe('render-report command line', () => {
  const path = () => {
    const file = join(directory, 'input.json');
    writeFileSync(file, JSON.stringify({ outcome: 'agent_failed', failure_reason: 'timeout' }));
    return file;
  };

  it('prints Markdown', () => {
    const result = spawnSync(process.execPath, [RENDER, '--input', path()], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.startsWith(REPORT_MARKER));
  });

  it('prints JSON for the workflow', () => {
    const result = spawnSync(process.execPath, [RENDER, '--input', path(), '--json'], { encoding: 'utf8' });
    const report = JSON.parse(result.stdout);
    assert.equal(report.conclusion, 'neutral');
    assert.match(report.title, /could not finish/);
  });

  it('exits with 2 and a message on a bad input', () => {
    const result = spawnSync(process.execPath, [RENDER, '--input', join(directory, 'absent.json')], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^render-report: /);
  });
});

describe('readTranscript', () => {
  const assistant = (...content) => ({ type: 'assistant', message: { content } });
  const toolUse = (name, input) => ({ type: 'tool_use', name, input });
  const messages = [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', tools: ['Read'] },
    assistant({ type: 'text', text: 'I used the skill frontend-unit-tests' }, toolUse('Skill', { skill: 'backend-unit-tests' })),
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
    assistant(toolUse('Skill', { skill: 'backend-unit-tests' }), toolUse('Write', { file_path: 'a' })),
    { type: 'result', subtype: 'success', num_turns: 4, total_cost_usd: 0.5, structured_output: { decision: 'failed' }, permission_denials: [{}, {}] },
  ];

  const check = (text) => {
    const transcript = readTranscript(text);
    assert.deepEqual(transcript.skills, ['backend-unit-tests'], 'only real tool calls count, not text');
    assert.deepEqual(transcript.tools, ['Skill', 'Write']);
    assert.equal(transcript.model, 'claude-sonnet-5-5');
    assert.equal(transcript.turns, 4);
    assert.equal(transcript.costUsd, 0.5);
    assert.deepEqual(transcript.structuredOutput, { decision: 'failed' });
    assert.equal(transcript.outcome, 'success');
    assert.equal(transcript.denials, 2);
  };

  it('reads one JSON object per line', () => {
    check(messages.map((message) => JSON.stringify(message)).join('\n'));
  });

  it('reads a single JSON array', () => {
    check(JSON.stringify(messages));
  });

  it('survives a transcript cut off by a crash', () => {
    const text = `${JSON.stringify(messages[0])}\n${JSON.stringify(messages[1])}\n{"type":"assis`;
    const transcript = readTranscript(text);
    assert.deepEqual(transcript.skills, ['backend-unit-tests']);
    assert.equal(transcript.outcome, null);
    assert.equal(transcript.turns, null);
  });

  it('survives empty or strange input', () => {
    for (const text of ['', undefined, 'not json', '[1,2', '[null]', 'null', '{"type":"assistant"}']) {
      assert.deepEqual(readTranscript(text).skills, []);
    }
  });

  it('reports a run stopped by the turn limit', () => {
    assert.equal(readTranscript(JSON.stringify({ type: 'result', subtype: 'error_max_turns' })).outcome, 'error_max_turns');
  });
});
