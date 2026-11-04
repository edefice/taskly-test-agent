#!/usr/bin/env node
// Runs Stryker on the changed lines of source files, after the gate has accepted the tests.
// It finds tests that pass and check little. It runs code from the branch, so it must only
// run where no secret is available. What it finds is a warning and never fails the gate.
//
//   mutate-changed-lines.mjs --base <ref> [--source-files a,b] [--out <file>] [--feedback-out <file>]
//   mutate-changed-lines.mjs --source-files a,b [--out <file>] [--feedback-out <file>]
//
// Without --base, whole files are mutated. Exit codes: 0 ran, or could not run and said why
// in the output, 2 wrong usage.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeChanges } from '../../pr-change-analysis/scripts/analyze-changes.mjs';
import { chooseTargets, MAX_CHANGED_LINES, mutationFeedback, summarizeMutationReport } from './lib/mutation.mjs';
import { sanitizeLog } from './lib/sanitize-log.mjs';
import { changedLinesFor, defaultExec, PACKAGES } from './verify-tests.mjs';

export const MUTATION_TIMEOUT_MS = 4 * 60 * 1000;
const SANDBOX_DIR = '.stryker-tmp';
const VITEST_CONFIG = { backend: 'vitest.config.ts', frontend: 'vite.config.ts' };

/**
 * The config comes from this file and not from the branch. Forks keep the default pool of
 * Vitest: in worker threads vi.stubEnv('TZ', ...) does not change the zone, so a test that
 * uses it would fail the first run and stop all of Stryker.
 */
export function strykerConfig({ packageName, mutate, reportFile }) {
  return {
    testRunner: 'vitest',
    vitest: { configFile: VITEST_CONFIG[packageName], pool: 'forks' },
    mutate,
    reporters: ['json'],
    jsonReporter: { fileName: reportFile },
    tempDirName: SANDBOX_DIR,
    cleanTempDir: 'always',
  };
}

function runPackage({ exec, repo, packageName, mutate, timeoutMs }) {
  const directory = mkdtempSync(join(tmpdir(), 'mutate-'));
  const reportFile = join(directory, 'mutation.json');
  const configFile = join(directory, 'stryker.config.json');
  const packageDir = join(repo, packageName);
  const startedAt = Date.now();
  try {
    writeFileSync(configFile, JSON.stringify(strykerConfig({ packageName, mutate, reportFile })));
    const run = exec('npm', ['exec', '--no', '--', 'stryker', 'run', configFile], { cwd: packageDir, timeoutMs });
    const durationMs = Date.now() - startedAt;
    if (run.timedOut) return { status: 'timed_out', duration_ms: durationMs };
    if (run.status !== 0) return { status: 'failed', duration_ms: durationMs, log: sanitizeLog(`${run.stdout}\n${run.stderr}`) };
    // Changed lines with nothing to mutate still give a report, with no mutants in it.
    if (!existsSync(reportFile)) return { status: 'failed', duration_ms: durationMs, log: 'Stryker exited with code 0 and wrote no report.' };
    return { status: 'completed', duration_ms: durationMs, ...summarizeMutationReport(JSON.parse(readFileSync(reportFile, 'utf8')), packageName) };
  } catch (error) {
    return { status: 'failed', duration_ms: Date.now() - startedAt, log: sanitizeLog(error.message) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(join(packageDir, SANDBOX_DIR), { recursive: true, force: true });
  }
}

/**
 * Mutates the changed lines of the given source files.
 * @param {object} options
 * @param {string} options.repo Repository root.
 * @param {string[]} options.sourceFiles Repository-relative source files.
 * @param {string} [options.mergeBase] Limits the run to changed lines. Without it, whole files.
 */
export function runMutation({ repo, sourceFiles, mergeBase, exec = defaultExec, timeoutMs = MUTATION_TIMEOUT_MS }) {
  const result = { schema_version: 1, status: 'completed', reason: null, skipped_paths: [], packages: {}, mutants: [] };
  const changedLines = mergeBase ? changedLinesFor(exec, repo, mergeBase, sourceFiles) : undefined;
  const { targets, skipped_paths: skippedPaths, changed_lines: lineCount } = chooseTargets(sourceFiles, changedLines);
  result.skipped_paths = skippedPaths;
  if (lineCount > MAX_CHANGED_LINES) {
    return { ...result, status: 'skipped', reason: `The change has ${lineCount} changed source lines, over the limit of ${MAX_CHANGED_LINES}.` };
  }
  const packages = PACKAGES.filter((name) => targets[name]?.length > 0);
  if (packages.length === 0) return { ...result, status: 'skipped', reason: 'No changed source lines can be mutated.' };
  for (const packageName of packages) {
    const { mutants = [], ...entry } = runPackage({ exec, repo, packageName, mutate: targets[packageName], timeoutMs });
    result.packages[packageName] = entry;
    result.mutants.push(...mutants);
  }
  if (Object.values(result.packages).some(({ status }) => status === 'failed' || status === 'timed_out')) result.status = 'incomplete';
  return result;
}

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      out: { type: 'string' },
      'feedback-out': { type: 'string' },
      'source-files': { type: 'string' },
    },
  });
  const root = defaultExec('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() });
  if (root.status !== 0) throw new Error('This is not a git repository.');
  const repo = realpathSync(root.stdout.trim());
  const analysis = values.base ? analyzeChanges({ cwd: repo, base: values.base }) : null;
  const sourceFiles = values['source-files'] ? values['source-files'].split(',') : analysis?.source_files;
  if (!sourceFiles) throw new Error('Usage: mutate-changed-lines.mjs --base <ref> | --source-files <a,b> [--out <file>] [--feedback-out <file>]');
  const result = runMutation({ repo, sourceFiles, mergeBase: analysis?.merge_base });
  if (values.out) writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  const feedback = mutationFeedback(result);
  if (values['feedback-out'] && feedback) writeFile(values['feedback-out'], `${feedback}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`mutate-changed-lines: ${error.message}\n`);
    process.exitCode = 2;
  }
}
