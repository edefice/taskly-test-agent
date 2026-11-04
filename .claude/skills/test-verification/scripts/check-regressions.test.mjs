import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { classifyFailures, runRegressionCheck } from './check-regressions.mjs';

const A = 'backend/tests/a.test.ts > keeps a';
const B = 'backend/tests/a.test.ts > keeps b';
const NEW = 'backend/tests/new.test.ts > new behavior';

describe('classifyFailures', () => {
  it('calls a test green on the base and red twice on the head a regression', () => {
    assert.deepEqual(classifyFailures({ failed: [A], failedAgain: [A], basePassed: [A, B] }), { regressions: [A], baseline_red: [] });
  });

  it('does not blame the pull request for a test also red on the base', () => {
    assert.deepEqual(classifyFailures({ failed: [A], failedAgain: [A], basePassed: [B] }), { regressions: [], baseline_red: [A] });
  });

  it('does not call a test that the pull request added a regression', () => {
    assert.deepEqual(classifyFailures({ failed: [NEW], failedAgain: [NEW], basePassed: [A] }), { regressions: [], baseline_red: [NEW] });
  });

  it('does not call a test that passed when run again a regression, because it is flaky', () => {
    assert.deepEqual(classifyFailures({ failed: [A], failedAgain: [], basePassed: [A] }), { regressions: [], baseline_red: [A] });
  });

  it('proves nothing when a run gave no report, so the check is not red', () => {
    assert.deepEqual(classifyFailures({ failed: [A], failedAgain: null, basePassed: [A] }), { regressions: [], baseline_red: [A] });
    assert.deepEqual(classifyFailures({ failed: [A], failedAgain: [A], basePassed: null }), { regressions: [], baseline_red: [A] });
  });

  it('counts a file that stopped loading, if it had passing tests on the base', () => {
    const broken = 'backend/tests/a.test.ts > (the file failed to load)';
    assert.deepEqual(classifyFailures({ failed: [broken], failedAgain: [broken], basePassed: [A] }).regressions, [broken]);
    assert.deepEqual(classifyFailures({ failed: [broken], failedAgain: [broken], basePassed: ['backend/tests/z.test.ts > other'] }).regressions, []);
  });

  it('sorts a mix', () => {
    const result = classifyFailures({ failed: [A, B, NEW], failedAgain: [A, B, NEW], basePassed: [A] });
    assert.deepEqual(result, { regressions: [A], baseline_red: [B, NEW] });
  });
});

describe('runRegressionCheck', () => {
  let root;
  let repo;
  let baseDir;

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'regressions-test-')));
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    repo = mkdtempSync(join(root, 'head-'));
    baseDir = mkdtempSync(join(root, 'base-'));
  });

  /** Stands in for npm and writes a Vitest report for the checkout it is called in. */
  const fakeExec = (byCheckout) => {
    const calls = [];
    const exec = (command, args, { cwd }) => {
      calls.push({ cwd, args });
      const tests = cwd === repo ? byCheckout.head : byCheckout.base;
      const outputFile = args.find((arg) => arg.startsWith('--outputFile=')).slice('--outputFile='.length);
      if (tests !== null) {
        mkdirSync(join(cwd, 'backend/tests'), { recursive: true });
        const assertionResults = Object.entries(tests).map(([fullName, status]) => ({ fullName, status, failureMessages: status === 'failed' ? ['boom'] : [] }));
        writeFileSync(outputFile, JSON.stringify({ success: false, testResults: [{ name: join(cwd, 'backend/tests/a.test.ts'), status: 'passed', assertionResults }] }));
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    return { exec, calls };
  };
  const baseline = (failed, ran = true) => ({ packages: { backend: { ran, total: 2, failed } } });

  it('finds a regression, reading ids from each checkout', () => {
    const { exec } = fakeExec({ head: { 'keeps a': 'failed', 'keeps b': 'passed' }, base: { 'keeps a': 'passed', 'keeps b': 'passed' } });
    const result = runRegressionCheck({ repo, baseDir, baseline: baseline([A]), exec });
    assert.deepEqual(result.regressions, [A]);
    assert.deepEqual(result.not_checked, []);
  });

  it('runs nothing when nothing is red, because the base has nothing to add', () => {
    const { exec, calls } = fakeExec({ head: {}, base: {} });
    const result = runRegressionCheck({ repo, baseDir, baseline: baseline([]), exec });
    assert.deepEqual(calls, []);
    assert.deepEqual(result, { schema_version: 1, regressions: [], baseline_red: [], not_checked: [] });
  });

  it('runs each checkout once and in the right place', () => {
    const { exec, calls } = fakeExec({ head: { 'keeps a': 'failed' }, base: { 'keeps a': 'failed' } });
    runRegressionCheck({ repo, baseDir, baseline: baseline([A]), exec });
    assert.deepEqual(calls.map(({ cwd }) => cwd), [repo, baseDir]);
    assert.ok(calls.every(({ args }) => args.includes('backend') && args.includes('test')));
  });

  it('reports a base that gave no report as not checked, and not as a regression', () => {
    const { exec } = fakeExec({ head: { 'keeps a': 'failed' }, base: null });
    const result = runRegressionCheck({ repo, baseDir, baseline: baseline([A]), exec });
    assert.deepEqual(result.regressions, []);
    assert.deepEqual(result.baseline_red, [A]);
    assert.deepEqual(result.not_checked, ['backend']);
  });

  it('reports a package with no baseline report as not checked', () => {
    const { exec, calls } = fakeExec({ head: {}, base: {} });
    const result = runRegressionCheck({ repo, baseDir, baseline: baseline([], false), exec });
    assert.deepEqual(result.not_checked, ['backend']);
    assert.deepEqual(calls, []);
  });
});
