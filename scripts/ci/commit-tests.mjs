#!/usr/bin/env node
// The only step with write access to the repository. It trusts nothing from earlier jobs: the
// patch comes from a job that ran code from the branch, so it goes through the same check as
// before, and through a search for anything shaped like a credential. It runs no code from the
// branch. Git hooks do not come from a clone, and it installs nothing.
//
//   ARTIFACTS=<dir> OUT=<dir> HEAD_SHA=<sha> HEAD_REF=<branch> RUN_ID=<id> commit-tests.mjs
//
// Writes commit.json. A missing commit is a result, not a failure, so it exits with 0.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CREDENTIAL } from '../../.claude/skills/test-verification/scripts/lib/sanitize-log.mjs';
import { BOT_TRAILER } from './analyze-pr.mjs';
import { readJson, requireEnv, writeJson } from './lib/github.mjs';
import { applyPatch, git } from './lib/patch.mjs';

const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

/** Reads the record of each round that left one, in order. */
export function readRounds(artifacts) {
  if (!existsSync(artifacts)) return [];
  return readdirSync(artifacts)
    .map((name) => /^gate-round-(\d+)$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map(([name]) => ({ directory: join(artifacts, name), record: readJson(join(artifacts, name, 'round.json')) }))
    .filter(({ record }) => record);
}

/** The newest accepted attempt. A repair round that made tests worse does not replace it. */
export function chooseRound(rounds) {
  return rounds.findLast(({ record }) => record.accepted === true) ?? null;
}

export function commitMessage(runId) {
  return `test: add unit tests from the unit test agent\n\nThe gate accepted these tests in run ${runId}.\n\n${BOT_TRAILER} ${runId}\n`;
}

/**
 * @param {object} options
 * @param {string} options.repo A clean checkout of the pull request, with credentials to push.
 * @param {string} options.artifacts Holds gate-round-<n>/ directories.
 * @param {string} options.headSha The commit this run worked on.
 * @param {string} options.headRef The branch of the pull request.
 * @param {string} options.runId
 * @returns {{ committed: boolean, stale?: boolean, commit_sha?: string, round?: number, reason?: string }}
 */
export function commitTests({ repo, artifacts, headSha, headRef, runId }) {
  const chosen = chooseRound(readRounds(artifacts));
  if (!chosen) return { committed: false, reason: 'No attempt was accepted.' };
  const { round } = chosen.record;

  if (git(repo, ['rev-parse', 'HEAD']).stdout.trim() !== headSha) return { committed: false, stale: true, round, reason: 'The checkout is not the commit this run worked on.' };
  // The branch may have moved during the run. A commit on top would be tests for old code.
  const remote = git(repo, ['ls-remote', 'origin', `refs/heads/${headRef}`]).stdout.split('\t')[0].trim();
  if (remote !== headSha) return { committed: false, stale: true, round, reason: 'A newer commit arrived during this run.' };

  const { applied, paths, problems } = applyPatch(repo, join(chosen.directory, 'gate.patch'));
  if (!applied) return { committed: false, round, reason: `The patch was refused: ${problems.map(({ path, reason }) => `${path} ${reason}`).slice(0, 5).join('; ')}` };
  if (paths.length === 0) return { committed: false, round, reason: 'The accepted patch changes nothing.' };

  // Looks at added lines, because an existing test may hold a made-up key.
  const added = git(repo, ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD']).stdout.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  if (added.search(new RegExp(CREDENTIAL.source)) !== -1) {
    git(repo, ['reset', '--hard', '-q', 'HEAD']);
    return { committed: false, round, reason: 'The patch holds text shaped like a credential.' };
  }

  git(repo, ['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, 'commit', '--no-verify', '--no-gpg-sign', '-q', '-F', '-'], { input: commitMessage(runId) });
  const commitSha = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  // No force. If the branch moved after the check above, the push fails and nothing is lost.
  const push = git(repo, ['push', '-q', 'origin', `HEAD:refs/heads/${headRef}`], { allowFailure: true });
  if (push.status !== 0) return { committed: false, stale: true, round, reason: 'The push was refused, most likely because a newer commit arrived.' };
  return { committed: true, commit_sha: commitSha, round, paths };
}

function main(env = process.env) {
  const result = commitTests({
    repo: realpathSync(env.GITHUB_WORKSPACE ?? process.cwd()),
    artifacts: requireEnv('ARTIFACTS', env),
    headSha: requireEnv('HEAD_SHA', env),
    headRef: requireEnv('HEAD_REF', env),
    runId: requireEnv('RUN_ID', env),
  });
  writeJson(join(requireEnv('OUT', env), 'commit.json'), result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`commit-tests: ${error.message}\n`);
    process.exitCode = 1;
  }
}
