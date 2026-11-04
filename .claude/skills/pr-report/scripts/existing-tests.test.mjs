import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { compareTestFile } from '../../test-verification/scripts/lib/test-rules.mjs';
import { runVerify } from '../../test-verification/scripts/verify-tests.mjs';
import { claimMismatches } from './claim-check.mjs';
import { renderReport } from './render-report.mjs';

const PATH = 'frontend/src/a.test.tsx';
const ONE = "it('creates a task', () => {\n  expect(create()).toBe(1)\n})\n";
const TWO = "it('updates a task', () => {\n  expect(update()).toBe(2)\n})\n";

describe('compareTestFile', () => {
  it('counts added and removed lines', () => {
    const { added_lines: added, removed_lines: removed } = compareTestFile({ before: 'a\nb\n', after: 'a\nc\nd\n' });
    assert.deepEqual({ added, removed }, { added: 2, removed: 1 });
  });

  it('finds a test that gained an assertion', () => {
    const after = "it('creates a task', () => {\n  expect(create()).toBe(1)\n  expect(blank()).toBe(true)\n})\n";
    assert.deepEqual(compareTestFile({ before: ONE, after }).changed_tests, ['creates a task']);
  });

  it('does not count a new test next to an existing one as a change to it', () => {
    assert.deepEqual(compareTestFile({ before: ONE, after: `${ONE}\n${TWO}` }).changed_tests, []);
    assert.deepEqual(compareTestFile({ before: ONE, after: `${TWO}\n${ONE}` }).changed_tests, []);
  });

  it('does not count a test that only moved or was reformatted', () => {
    const reformatted = "it('creates a task',\n  () => {\n    expect(create())\n      .toBe(1)\n  })\n";
    assert.deepEqual(compareTestFile({ before: `${ONE}${TWO}`, after: `${TWO}${ONE}` }).changed_tests, []);
    assert.deepEqual(compareTestFile({ before: ONE, after: reformatted }).changed_tests, []);
  });

  it('does not list a removed test here, because the gate rejects that', () => {
    assert.deepEqual(compareTestFile({ before: `${ONE}${TWO}`, after: ONE }).changed_tests, []);
  });

  it('is not misled by brackets in strings and comments', () => {
    const body = (text) => `it('reads', () => {\n  expect(a('${text}')).toBe(1) // ) } ]\n  /* ) */\n})\nit('next', () => { expect(2).toBe(2) })\n`;
    const result = compareTestFile({ before: body('('), after: body(')') });
    assert.deepEqual(result.changed_tests, ['reads']);
  });

  it('reads a change that comes after a nested block', () => {
    const body = (last) => `it('reads', () => {\n  if (a) {\n    b()\n  }\n  ${last}()\n})\n`;
    assert.deepEqual(compareTestFile({ before: body('c'), after: body('d') }).changed_tests, ['reads']);
  });

  it('reads a change that comes after a template string full of closing brackets', () => {
    const body = (last) => `it('reads', () => {\n  a(\`}})\`)\n  ${last}()\n})\n`;
    assert.deepEqual(compareTestFile({ before: body('c'), after: body('d') }).changed_tests, ['reads']);
  });

  it('reads a template string with brackets', () => {
    const body = (value) => `it('reads', () => {\n  expect(\`)\${${value}})\`).toBe(1)\n})\nit('next', () => { expect(2).toBe(2) })\n`;
    assert.deepEqual(compareTestFile({ before: body('a'), after: body('b') }).changed_tests, ['reads']);
  });

  it('handles the same title twice', () => {
    const twice = (one, other) => `describe('a', () => { it('same', () => { ${one} }) })\ndescribe('b', () => { it('same', () => { ${other} }) })\n`;
    assert.deepEqual(compareTestFile({ before: twice('x()', 'y()'), after: twice('y()', 'x()') }).changed_tests, []);
    assert.deepEqual(compareTestFile({ before: twice('y()', 'x()'), after: twice('x()', 'y()') }).changed_tests, []);
    assert.deepEqual(compareTestFile({ before: twice('x()', 'y()'), after: twice('x()', 'z()') }).changed_tests, ['same']);
  });

  it('leaves out a test whose end it cannot find, instead of raising a false alarm', () => {
    assert.deepEqual(compareTestFile({ before: "it('open', () => {", after: "it('open', () => { x()" }).changed_tests, []);
    assert.deepEqual(compareTestFile({ before: "it('open', () => {", after: "it('open', () => { x() })" }).changed_tests, []);
  });
});

describe('claimMismatches', () => {
  const verification = (tests = ['creates a task']) => ({ modified_test_files: [{ path: PATH, added_lines: 1, removed_lines: 0, changed_tests: tests }] });
  const result = (justification, reasoning = 'Added tests.') => ({ reasoning, existing_tests_changed: justification ? [{ path: PATH, justification }] : [] });

  it('catches the claim from the real run', () => {
    const justification = 'Existing test file extended with new cases for the update, error and guard paths. The original create test was kept unchanged.';
    assert.deepEqual(claimMismatches(result(justification), verification()), [{ path: PATH, kind: 'claims_unchanged', tests: ['creates a task'] }]);
  });

  for (const claim of [
    'Existing tests were not modified.',
    "I didn't change the existing test.",
    'The tests are untouched.',
    'I added cases without changing the existing tests.',
    'The existing test was left as is.',
    'Existing tests have not been altered.',
  ]) {
    it(`catches ${JSON.stringify(claim)}`, () => {
      assert.equal(claimMismatches(result(claim), verification())[0]?.kind, 'claims_unchanged');
    });
  }

  it('catches the claim in the reasoning too', () => {
    assert.equal(claimMismatches(result('Needed a new mock.', 'I did not change any existing test.'), verification())[0]?.kind, 'claims_unchanged');
  });

  it('accepts an honest reason', () => {
    assert.deepEqual(claimMismatches(result('The create test now checks that the form starts blank.'), verification()), []);
  });

  it('does not take a sentence about the application for a claim about tests', () => {
    assert.deepEqual(claimMismatches(result('The test needed a new assertion. The application code is unchanged.'), verification()), []);
  });

  it('says so when the agent does not mention a changed test at all', () => {
    assert.equal(claimMismatches(result(null), verification())[0]?.kind, 'not_mentioned');
  });

  it('has nothing to say when the diff shows no changed existing test, so a true claim is fine', () => {
    assert.deepEqual(claimMismatches(result('Added new tests. Existing tests are unchanged.'), verification([])), []);
  });

  it('has nothing to say with no result or no gate report', () => {
    assert.deepEqual(claimMismatches(undefined, verification()), []);
    assert.deepEqual(claimMismatches(result('Unchanged tests.'), undefined), []);
  });
});

describe('renderReport: existing test files', () => {
  const resultOf = (overrides = {}) => ({ decision: 'tests_added', reasoning: 'Added tests.', files: [{ path: PATH, action: 'modified' }], tests: [], skills_used: [], existing_tests_changed: [], regressions: [], suspected_bugs: [], ...overrides });
  const verificationOf = (files) => ({ changed_files: [{ path: PATH, class: 'test' }], shared_test_support: [], failures: [], packages: {}, modified_test_files: files });
  const file = (overrides = {}) => ({ path: PATH, added_lines: 111, removed_lines: 2, changed_tests: ['creates a task'], ...overrides });
  const render = (input) => renderReport({ outcome: 'tests_added', head_sha: 'abc', usage: {}, result: resultOf(), verification: verificationOf([file()]), ...input });

  it('shows what the diff shows, whatever the agent says', () => {
    const { markdown } = render({ result: resultOf({ existing_tests_changed: [] }) });
    assert.match(markdown, /#### Existing test files modified\n\n- `frontend\/src\/a\.test\.tsx`: \+111 and -2 lines\. Existing tests changed: `creates a task`\./);
  });

  it('shows the file even when no existing test changed', () => {
    assert.match(render({ verification: verificationOf([file({ changed_tests: [] })]) }).markdown, /\+111 and -2 lines\. No existing test changed\./);
  });

  it('has no section when no existing test file was modified', () => {
    assert.doesNotMatch(render({ verification: verificationOf([]) }).markdown, /Existing test files modified/);
  });

  it('shows the reason as the words of the agent, once', () => {
    const { markdown } = render({ result: resultOf({ existing_tests_changed: [{ path: PATH, justification: 'The form now starts blank.' }] }) });
    assert.match(markdown, /The agent says: The form now starts blank\./);
    assert.equal(markdown.match(/The form now starts blank/g).length, 1);
  });

  it('marks the false claim from the real run as a mismatch', () => {
    const { markdown, conclusion } = render({ result: resultOf({ existing_tests_changed: [{ path: PATH, justification: 'The original create test was kept unchanged.' }] }) });
    assert.match(markdown, /#### The agent and the diff disagree\n\n- `frontend\/src\/a\.test\.tsx`: The agent says existing tests are unchanged, but the diff shows changes to `creates a task`\. This is a warning/);
    assert.equal(conclusion, 'success', 'a warning, not a rejection');
  });

  it('marks a change the agent does not mention', () => {
    assert.match(render({}).markdown, /The agent does not mention this change, but the diff shows changes to `creates a task`/);
  });

  it('has no mismatch for an honest result', () => {
    const { markdown } = render({ result: resultOf({ existing_tests_changed: [{ path: PATH, justification: 'The form now starts blank.' }] }) });
    assert.doesNotMatch(markdown, /disagree/);
  });

  it('makes test titles and the reason from the branch safe', () => {
    const { markdown } = render({ verification: verificationOf([file({ changed_tests: ['`<img src=x> @someone'] })]), result: resultOf({ existing_tests_changed: [{ path: PATH, justification: '<script>alert(1)</script> @someone' }] }) });
    assert.doesNotMatch(markdown, /<script>/);
    assert.doesNotMatch(markdown, /(?<!`[^`]*)@someone/);
  });

  it('still shows the words of the agent when there is no diff to compare, as after a failed run', () => {
    const { markdown } = renderReport({ outcome: 'agent_failed', head_sha: 'abc', usage: {}, result: resultOf({ existing_tests_changed: [{ path: PATH, justification: 'The form now starts blank.' }] }) });
    assert.match(markdown, /#### Existing tests changed\n\n- `frontend\/src\/a\.test\.tsx`: The form now starts blank\./);
  });
});

describe('runVerify: existing test files, with real git', () => {
  const FRONTEND_TEST = 'backend/tests/a.test.ts';
  const COMMITTER = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  let root;
  let repo;
  const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...COMMITTER } });
  const write = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  /** Keeps real git and stands in for npm, with one passing test. */
  const exec = (command, args, options) => {
    if (command === 'git') {
      const result = spawnSync('git', args, { cwd: options.cwd, encoding: 'utf8', env: { ...process.env, ...COMMITTER } });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }
    const outputFile = args.find((arg) => arg.startsWith('--outputFile='));
    if (outputFile) {
      writeFileSync(outputFile.slice('--outputFile='.length), JSON.stringify({ success: true, testResults: [{ name: join(repo, FRONTEND_TEST), status: 'passed', assertionResults: [{ fullName: 'creates a task', status: 'passed' }] }] }));
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'existing-tests-')));
    repo = root;
    run('init', '-q', '-b', 'main');
    write(FRONTEND_TEST, ONE);
    run('add', '-A');
    run('commit', '-q', '--no-gpg-sign', '-m', 'base');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('reports a modified existing file and leaves a new file out', () => {
    write(FRONTEND_TEST, "it('creates a task', () => {\n  expect(create()).toBe(1)\n  expect(more()).toBe(2)\n})\n");
    write('backend/tests/new.test.ts', TWO);
    const report = runVerify({ repo, exec });
    assert.deepEqual(report.modified_test_files, [{ path: FRONTEND_TEST, added_lines: 1, removed_lines: 0, changed_tests: ['creates a task'] }]);
  });
});
