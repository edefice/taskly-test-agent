#!/usr/bin/env node
// After the baseline: says whether any test is red, so the base commit is checked out and
// installed only when there is something to compare. With nothing red there is no regression,
// and this writes that result.
//
//   baseline-red.mjs <directory with baseline.json>
//
// Step output: red.

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, setOutputs, writeJson } from './lib/github.mjs';

/** A package with no report is red too, because the comparison is what says so. */
export function hasRedTests(baseline) {
  return Object.values(baseline?.packages ?? {}).some(({ ran, failed }) => !ran || failed.length > 0);
}

function main(directory, env = process.env) {
  if (!directory) throw new Error('Usage: baseline-red.mjs <directory>');
  const baseline = readJson(join(directory, 'baseline.json'));
  if (!baseline) throw new Error('There is no baseline.');
  const red = hasRedTests(baseline);
  // What the comparison would write, for a run with nothing to compare. A run that compares replaces it.
  const failed = Object.values(baseline.packages ?? {}).flatMap((entry) => entry.failed);
  writeJson(join(directory, 'regressions.json'), { schema_version: 1, regressions: [], baseline_red: failed, not_checked: red ? Object.keys(baseline.packages) : [] });
  setOutputs({ red }, env);
  process.stdout.write(`Red tests in the baseline: ${red}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main(process.argv[2]);
  } catch (error) {
    process.stderr.write(`baseline-red: ${error.message}\n`);
    process.exitCode = 1;
  }
}
