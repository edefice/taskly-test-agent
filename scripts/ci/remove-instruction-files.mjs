#!/usr/bin/env node
// Runs in the job with the agent, before the agent. It removes instruction files that came with
// the pull request, so this defense does not depend on how the model reacts to them. A failure
// stops the job before the agent starts. It prints only a count, because a file name is text from
// the pull request and could hold a workflow command.
//
//   remove-instruction-files.mjs
//
// The removal shows up as a deleted file, which collect-agent-output reports and leaves out of the patch.

import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isInstructionFile } from './lib/instruction-files.mjs';
import { git } from './lib/patch.mjs';

/** @returns {string[]} The paths it removed. A file it cannot remove throws, which stops the agent. */
export function removeInstructionFiles({ repo }) {
  const removed = git(repo, ['ls-files', '-z']).stdout.split('\0').filter(Boolean).filter(isInstructionFile);
  for (const path of removed) rmSync(join(repo, path), { recursive: true, force: true });
  return removed;
}

function main(env = process.env) {
  const removed = removeInstructionFiles({ repo: realpathSync(env.GITHUB_WORKSPACE ?? process.cwd()) });
  process.stdout.write(`Removed ${removed.length} instruction file(s) that came with the pull request.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`remove-instruction-files: ${error.message}\n`);
    process.exitCode = 1;
  }
}
