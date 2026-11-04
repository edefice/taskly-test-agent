import { relative, sep } from 'node:path';
import { sanitizeFailureMessage } from './sanitize-log.mjs';

const LOAD_FAILURE = '(the file failed to load)';

/** Reduces a Vitest JSON report to the test ids that passed and failed. */
export function summarizeReport(report, repo) {
  const passed = [];
  const failed = [];
  for (const file of report.testResults ?? []) {
    const path = relative(repo, file.name).split(sep).join('/');
    const assertions = file.assertionResults ?? [];
    for (const test of assertions) {
      const id = `${path} > ${test.fullName}`;
      if (test.status === 'passed') {
        passed.push(id);
      } else if (test.status === 'failed') {
        failed.push({ id, message: sanitizeFailureMessage((test.failureMessages ?? []).join('\n')) });
      }
    }
    // A file can fail with no tests to report, for example on a syntax error.
    if (file.status === 'failed' && !assertions.some((test) => test.status === 'failed')) {
      failed.push({ id: `${path} > ${LOAD_FAILURE}`, message: sanitizeFailureMessage(file.message) });
    }
  }
  return { success: report.success === true, total: passed.length + failed.length, passed, failed };
}

/** Splits repeated runs into tests that always fail and tests that sometimes fail. */
export function compareRuns(runs) {
  const failures = new Map();
  for (const run of runs) {
    for (const failure of run.failed) {
      const entry = failures.get(failure.id) ?? { ...failure, count: 0 };
      entry.count += 1;
      failures.set(failure.id, entry);
    }
  }
  const failed = [];
  const flaky = [];
  for (const { id, message, count } of failures.values()) {
    (count === runs.length ? failed : flaky).push({ id, message, failed_runs: count });
  }
  return { failed, flaky };
}
