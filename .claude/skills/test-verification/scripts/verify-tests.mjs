#!/usr/bin/env node
// Decides whether the test changes in the working tree are acceptable. It is code on
// purpose: the agent's own opinion of its tests does not count. It runs the tests, so
// it runs code from the branch. It must only run where no secret is available.
//
//   verify-tests.mjs baseline --out <file> [--packages backend,frontend]
//   verify-tests.mjs verify [--base <ref>] [--source-files a,b] [--baseline <file>] [--out <file>]
//
// Exit codes: 0 passed or nothing to verify, 1 failed, 2 could not run.

import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyTestPath } from '../../../lib/test-paths.mjs';
import { analyzeChanges } from '../../pr-change-analysis/scripts/analyze-changes.mjs';
import { changedLinesFromDiff, clearCoverage, compareCoverage, readCoverage, serializableCoverage } from './lib/coverage.mjs';
import { sanitizeLog } from './lib/sanitize-log.mjs';
import { checkTestFile, compareTestFile } from './lib/test-rules.mjs';
import { compareRuns, summarizeReport } from './lib/vitest-results.mjs';

export const PACKAGES = ['backend', 'frontend'];
export const NEW_TEST_RUNS = 3;

const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
// The later runs change the order, which also finds tests that depend on each other.
const SHUFFLE_SEEDS = [null, 4242, 7331];
// Far from UTC, so a date that is wrong by a day shows here.
export const SECOND_TIME_ZONE = 'Pacific/Auckland';

const SECRET_ENV = /^(?:ANTHROPIC_|CLAUDE_CODE_OAUTH|GH_TOKEN$|GITHUB_TOKEN$|GH_ENTERPRISE_TOKEN$|GITHUB_ENTERPRISE_TOKEN$|ACTIONS_(?:ID_TOKEN|RUNTIME)|AWS_|NPM_TOKEN$)/;

// With this set, Vitest adds a section to the Job Summary for each run with no explicit reporter.
// Stryker runs it that way, and each caught mutant is a failed run, so the summary filled with failures.
const NOT_FOR_TESTS_ENV = /^GITHUB_STEP_SUMMARY$/;

/** The tests run code from the branch, so credentials never reach them, even locally. */
export function childEnv(env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_ENV.test(name) && !NOT_FOR_TESTS_ENV.test(name)));
  return { ...clean, CI: 'true', TZ: 'UTC' };
}

export function defaultExec(command, args, { cwd, timeoutMs = COMMAND_TIMEOUT_MS, timeZone }) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...childEnv(), ...(timeZone ? { TZ: timeZone } : {}) },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

const logOf = (result) => sanitizeLog(`${result.stdout}\n${result.stderr}`);

function git(exec, repo, args) {
  const result = exec('git', ['-c', 'core.quotePath=false', '--no-pager', ...args], { cwd: repo });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${sanitizeLog(result.stderr, 500)}`);
  return result.stdout;
}

/** Runs one Vitest script and reads its JSON report. A missing report means a crash. */
export function runVitest(exec, repo, packageName, script, args, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'verify-tests-'));
  const outputFile = join(directory, 'report.json');
  try {
    const result = exec(
      'npm',
      ['--prefix', packageName, 'run', script, '--', '--reporter=json', `--outputFile=${outputFile}`, ...args],
      { cwd: repo, ...options },
    );
    let summary = null;
    try {
      summary = summarizeReport(JSON.parse(readFileSync(outputFile, 'utf8')), repo);
    } catch {
      summary = null;
    }
    return { status: result.status, timedOut: result.timedOut === true, log: logOf(result), summary };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runFullPackage(exec, repo, packageName) {
  clearCoverage(repo, packageName);
  // Vitest writes no coverage when a test fails unless told to, and a baseline
  // with a test that was already red still needs its coverage numbers.
  const run = runVitest(exec, repo, packageName, 'test:coverage', [
    '--coverage.reporter=lcov',
    '--coverage.reporter=json-summary',
    '--coverage.reportOnFailure',
  ]);
  return { ...run, coverage: readCoverage(repo, packageName) };
}

/** Lists changes in the working tree. --no-renames gives one path per entry. */
function workingTreeChanges(exec, repo) {
  const output = git(exec, repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  return output
    .split('\0')
    .filter(Boolean)
    .map((entry) => ({ state: entry.slice(0, 2), path: entry.slice(3) }));
}

function isSymlink(repo, path) {
  try {
    return lstatSync(join(repo, path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function fileAtHead(exec, repo, path) {
  const result = exec('git', ['--no-pager', 'show', `HEAD:${path}`], { cwd: repo });
  return result.status === 0 ? result.stdout : null;
}

function packageOf(path) {
  return PACKAGES.find((name) => path.startsWith(`${name}/`));
}

function checkScope(repo, changes) {
  const failures = [];
  for (const { state, path } of changes) {
    if (classifyTestPath(path) === null) {
      failures.push({ path, reason: 'is outside the test allowlist' });
    } else if (state.includes('D')) {
      failures.push({ path, reason: 'was deleted, and existing tests must not be removed' });
    } else if (isSymlink(repo, path)) {
      failures.push({ path, reason: 'is a symbolic link' });
    }
  }
  return failures;
}

function checkRules(exec, repo, changes) {
  const violations = [];
  const existingTestsChanged = [];
  const newTests = [];
  for (const { path } of changes) {
    const result = checkTestFile({
      path,
      before: fileAtHead(exec, repo, path),
      after: readFileSync(join(repo, path), 'utf8'),
      isTest: classifyTestPath(path) === 'test',
    });
    violations.push(...result.violations);
    newTests.push(...result.newTests.map((title) => ({ path, title })));
    if (result.changedExistingLines > 0) existingTestsChanged.push({ path, changed_lines: result.changedExistingLines });
  }
  return { violations, existingTestsChanged, newTests };
}

/** Facts about existing test files, from the code alone, after any formatting. The report trusts these over the agent. */
function modifiedTestFiles(exec, repo, changes) {
  const modified = [];
  for (const { path } of changes) {
    const before = fileAtHead(exec, repo, path);
    if (before !== null) modified.push({ path, ...compareTestFile({ before, after: readFileSync(join(repo, path), 'utf8') }) });
  }
  return modified;
}

export function changedLinesFor(exec, repo, mergeBase, sourceFiles) {
  const lines = new Map();
  if (!mergeBase) return lines;
  for (const path of sourceFiles) {
    const diff = git(exec, repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', `${mergeBase}..HEAD`, '--', path]);
    lines.set(path, changedLinesFromDiff(diff));
  }
  return lines;
}

function verifyNewTests(exec, repo, packageName, testFiles, failures) {
  const filters = testFiles.map((path) => relative(packageName, path));
  const runs = SHUFFLE_SEEDS.slice(0, NEW_TEST_RUNS).map((seed) =>
    runVitest(exec, repo, packageName, 'test', [
      '--expect.requireAssertions',
      ...(seed === null ? [] : ['--sequence.shuffle', `--sequence.seed=${seed}`]),
      ...filters,
    ]),
  );
  const crashed = runs.find((run) => run.summary === null);
  if (crashed) {
    failures.push({
      check: 'new-tests',
      package: packageName,
      message: crashed.timedOut ? 'The test run timed out.' : 'The test run ended without a report.',
      log: crashed.log,
    });
    return { runs: runs.length, passed: false, total: 0, failed: [], flaky: [] };
  }
  const { failed, flaky } = compareRuns(runs.map((run) => run.summary));
  if (failed.length > 0) {
    failures.push({ check: 'new-tests', package: packageName, message: `${failed.length} test(s) failed in every run.`, tests: failed });
  }
  if (flaky.length > 0) {
    failures.push({ check: 'flaky-tests', package: packageName, message: `${flaky.length} test(s) failed in only some runs.`, tests: flaky });
  }
  // Every run so far used UTC, where a mistake about the local date does not show.
  const zoneRun = runVitest(exec, repo, packageName, 'test', ['--expect.requireAssertions', ...filters], { timeZone: SECOND_TIME_ZONE });
  const known = new Set([...failed, ...flaky].map(({ id }) => id));
  const zoneFailed = (zoneRun.summary?.failed ?? []).filter(({ id }) => !known.has(id));
  if (zoneRun.summary === null) {
    failures.push({
      check: 'time-zone',
      package: packageName,
      message: `${zoneRun.timedOut ? 'The test run timed out' : 'The test run ended without a report'} in ${SECOND_TIME_ZONE}.`,
      log: zoneRun.log,
    });
  } else if (zoneFailed.length > 0) {
    failures.push({ check: 'time-zone', package: packageName, message: `${zoneFailed.length} test(s) passed in UTC and failed in ${SECOND_TIME_ZONE}.`, tests: zoneFailed });
  }
  return {
    runs: runs.length,
    passed: failed.length === 0 && flaky.length === 0 && zoneRun.summary !== null && zoneFailed.length === 0,
    total: runs[0].summary.total,
    failed: failed.map(({ id }) => id),
    flaky: flaky.map(({ id }) => id),
    second_time_zone: { zone: SECOND_TIME_ZONE, ran: zoneRun.summary !== null, failed: zoneFailed.map(({ id }) => id) },
  };
}

function verifyFullPackage(exec, repo, packageName, baseline, failures) {
  const run = runFullPackage(exec, repo, packageName);
  if (run.summary === null) {
    failures.push({
      check: 'full-package',
      package: packageName,
      message: run.timedOut ? 'The package test run timed out.' : 'The package test run ended without a report.',
      log: run.log,
    });
    return { run, result: { passed: false, total: 0, new_failures: [], baseline_failures: [] } };
  }
  const knownFailures = new Set(baseline?.failed ?? []);
  const newFailures = run.summary.failed.filter(({ id }) => !knownFailures.has(id));
  const baselineFailures = run.summary.failed.filter(({ id }) => knownFailures.has(id));
  if (newFailures.length > 0) {
    failures.push({
      check: 'full-package',
      package: packageName,
      message: `${newFailures.length} test(s) failed that did not fail before the agent ran.`,
      tests: newFailures,
    });
  } else if (run.status !== 0 && baselineFailures.length === 0) {
    // No test failed, but the run did. This includes coverage thresholds.
    failures.push({
      check: 'full-package',
      package: packageName,
      message: `The run exited with code ${run.status} although no test failed.`,
      log: run.log,
    });
  }
  return {
    run,
    result: {
      passed: !failures.some((failure) => failure.check === 'full-package' && failure.package === packageName),
      total: run.summary.total,
      new_failures: newFailures.map(({ id }) => id),
      baseline_failures: baselineFailures.map(({ id }) => id),
    },
  };
}

/** Records the state before the agent runs, so that red tests are not blamed on it. */
export function runBaseline({ repo, packages = PACKAGES, exec = defaultExec }) {
  const result = { schema_version: 1, packages: {} };
  for (const packageName of packages) {
    const run = runFullPackage(exec, repo, packageName);
    result.packages[packageName] = {
      ran: run.summary !== null,
      total: run.summary?.total ?? 0,
      failed: run.summary?.failed.map(({ id }) => id) ?? [],
      coverage: serializableCoverage(run.coverage),
    };
  }
  return result;
}

/**
 * Verifies the working tree.
 * @param {object} options
 * @param {string} options.repo Repository root.
 * @param {string} [options.mergeBase] Enables coverage of changed lines.
 * @param {string[]} [options.sourceFiles] Source files to report coverage for.
 * @param {object} [options.baseline] Output of runBaseline.
 */
export function runVerify({ repo, mergeBase, sourceFiles = [], baseline, exec = defaultExec }) {
  const startedAt = Date.now();
  const changes = workingTreeChanges(exec, repo);
  const failures = [];
  const report = {
    schema_version: 1,
    status: 'passed',
    changed_files: changes.map(({ path }) => ({ path, class: classifyTestPath(path) })),
    shared_test_support: changes.map(({ path }) => path).filter((path) => classifyTestPath(path) === 'shared-test-support'),
    existing_tests_changed: [],
    modified_test_files: [],
    new_tests: [],
    packages: {},
    failures,
  };
  const finish = () => {
    report.status = failures.length > 0 ? 'failed' : report.status;
    report.duration_ms = Date.now() - startedAt;
    return report;
  };

  if (changes.length === 0) {
    report.status = 'no_changes';
    return finish();
  }

  // Nothing from the working tree runs until every changed path is known to be allowed.
  const scopeFailures = checkScope(repo, changes);
  if (scopeFailures.length > 0) {
    failures.push({
      check: 'scope',
      message: `${scopeFailures.length} changed path(s) are not acceptable. Nothing was run.`,
      paths: scopeFailures,
    });
    return finish();
  }

  const { violations, existingTestsChanged, newTests } = checkRules(exec, repo, changes);
  report.existing_tests_changed = existingTestsChanged;
  report.new_tests = newTests;
  if (violations.length > 0) {
    failures.push({ check: 'test-rules', message: `${violations.length} rule violation(s).`, violations });
  }

  const changedPaths = changes.map(({ path }) => path);
  const changedLines = changedLinesFor(exec, repo, mergeBase, sourceFiles);
  for (const packageName of PACKAGES) {
    const inPackage = changedPaths.filter((path) => packageOf(path) === packageName);
    if (inPackage.length === 0) continue;
    const result = {};
    report.packages[packageName] = result;

    if (packageName === 'frontend') {
      const format = exec('npm', ['exec', '--no', '--', 'prettier', '--write', ...inPackage.map((path) => relative(packageName, path))], {
        cwd: join(repo, packageName),
      });
      result.format = { passed: format.status === 0 };
      if (format.status !== 0) {
        failures.push({ check: 'format', package: packageName, message: 'Prettier could not format the files.', log: logOf(format) });
      }
    }

    const typecheck = exec('npm', ['--prefix', packageName, 'run', 'typecheck'], { cwd: repo });
    result.typecheck = { passed: typecheck.status === 0 };
    if (typecheck.status !== 0) {
      failures.push({ check: 'typecheck', package: packageName, message: 'The package does not typecheck.', log: logOf(typecheck) });
    }

    const testFiles = inPackage.filter((path) => classifyTestPath(path) === 'test');
    if (testFiles.length > 0) result.new_tests = verifyNewTests(exec, repo, packageName, testFiles, failures);

    // Shared test support can break tests that did not change. The whole package always
    // runs for a package with changes, and this records why it matters for the report.
    result.shared_test_support_changed = inPackage.some((path) => classifyTestPath(path) === 'shared-test-support');
    const { run, result: full } = verifyFullPackage(exec, repo, packageName, baseline?.packages?.[packageName], failures);
    result.full_package = full;

    const before = baseline?.packages?.[packageName]?.coverage ?? null;
    result.coverage = compareCoverage({
      before,
      after: run.coverage,
      sourceFiles: sourceFiles.filter((path) => packageOf(path) === packageName),
      changedLines,
    });
  }
  report.modified_test_files = modifiedTestFiles(exec, repo, changes);
  return finish();
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function repositoryRoot() {
  const result = defaultExec('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() });
  if (result.status !== 0) throw new Error('This is not a git repository.');
  return realpathSync(result.stdout.trim());
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      base: { type: 'string' },
      baseline: { type: 'string' },
      out: { type: 'string' },
      packages: { type: 'string' },
      'source-files': { type: 'string' },
    },
  });
  const repo = repositoryRoot();

  if (command === 'baseline') {
    if (!values.out) throw new Error('baseline needs --out <file>.');
    const packages = values.packages ? values.packages.split(',') : PACKAGES;
    const unknown = packages.filter((name) => !PACKAGES.includes(name));
    if (unknown.length > 0) throw new Error(`Unknown package: ${unknown.join(', ')}`);
    writeJson(values.out, runBaseline({ repo, packages }));
    return 0;
  }

  if (command === 'verify') {
    const analysis = values.base ? analyzeChanges({ cwd: repo, base: values.base }) : null;
    const report = runVerify({
      repo,
      mergeBase: analysis?.merge_base,
      sourceFiles: values['source-files'] ? values['source-files'].split(',') : (analysis?.source_files ?? []),
      baseline: values.baseline ? JSON.parse(readFileSync(values.baseline, 'utf8')) : undefined,
    });
    if (values.out) writeJson(values.out, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === 'failed' ? 1 : 0;
  }

  throw new Error('Usage: verify-tests.mjs baseline|verify [options]. See the top of this file.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`verify-tests: ${error.message}\n`);
    process.exitCode = 2;
  }
}
