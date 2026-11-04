#!/usr/bin/env node
// Decides whether the pull request broke existing tests, before the agent adds anything. A
// test is a regression when it passes on the base commit and fails on the pull request, twice.
// Everything else that is red is not caused by this change and must not turn the check red. It
// runs code from the branch and from the base, so it must only run where no secret is available.
//
//   check-regressions.mjs --baseline <file> --base-dir <checkout of the base> [--out <file>]
//
// The baseline comes from verify-tests.mjs baseline, run on the pull request.
// Exit codes: 0 finished, whatever it found, 2 wrong usage.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { LOAD_FAILURE } from './lib/vitest-results.mjs';
import { defaultExec, runVitest } from './verify-tests.mjs';

const fileOf = (id) => id.slice(0, id.indexOf(' > '));

/** A file that no longer loads has no test ids left, so it counts as broken if it had passing tests. */
function passedOnBase(id, passed) {
  if (id.endsWith(` > ${LOAD_FAILURE}`)) return passed.some((other) => fileOf(other) === fileOf(id));
  return passed.includes(id);
}

/**
 * Sorts one package's failures on the pull request.
 * @param {object} state
 * @param {string[]} state.failed Tests red in the baseline.
 * @param {string[] | null} state.failedAgain Tests red when run again. Null when that run gave no report.
 * @param {string[] | null} state.basePassed Tests green on the base. Null when that run gave no report.
 * @returns {{ regressions: string[], baseline_red: string[] }}
 */
export function classifyFailures({ failed, failedAgain, basePassed }) {
  const regressions = [];
  const baselineRed = [];
  for (const id of failed) {
    const confirmed = failedAgain?.includes(id) ?? false;
    if (confirmed && basePassed && passedOnBase(id, basePassed)) regressions.push(id);
    else baselineRed.push(id);
  }
  return { regressions, baseline_red: baselineRed };
}

/**
 * @param {object} options
 * @param {string} options.repo Checkout of the pull request.
 * @param {string} options.baseDir Checkout of the base commit, with dependencies installed.
 * @param {object} options.baseline Output of runBaseline on the pull request.
 */
export function runRegressionCheck({ repo, baseDir, baseline, exec = defaultExec }) {
  const result = { schema_version: 1, regressions: [], baseline_red: [], not_checked: [] };
  for (const [packageName, entry] of Object.entries(baseline.packages ?? {})) {
    // A package with no report has no test ids to compare, so nothing can be proven about it.
    if (!entry.ran) {
      result.not_checked.push(packageName);
      continue;
    }
    if (entry.failed.length === 0) continue;
    const again = runVitest(exec, repo, packageName, 'test', []);
    const base = runVitest(exec, baseDir, packageName, 'test', []);
    if (again.summary === null || base.summary === null) result.not_checked.push(packageName);
    const { regressions, baseline_red: baselineRed } = classifyFailures({
      failed: entry.failed,
      failedAgain: again.summary?.failed.map(({ id }) => id) ?? null,
      basePassed: base.summary?.passed ?? null,
    });
    result.regressions.push(...regressions);
    result.baseline_red.push(...baselineRed);
  }
  return result;
}

function main() {
  const { values } = parseArgs({ options: { baseline: { type: 'string' }, 'base-dir': { type: 'string' }, out: { type: 'string' } } });
  if (!values.baseline || !values['base-dir']) throw new Error('Usage: check-regressions.mjs --baseline <file> --base-dir <dir> [--out <file>]');
  const root = defaultExec('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() });
  if (root.status !== 0) throw new Error('This directory is outside a repository.');
  const result = runRegressionCheck({
    repo: realpathSync(root.stdout.trim()),
    baseDir: realpathSync(values['base-dir']),
    baseline: JSON.parse(readFileSync(values.baseline, 'utf8')),
  });
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`check-regressions: ${error.message}\n`);
    process.exitCode = 2;
  }
}
