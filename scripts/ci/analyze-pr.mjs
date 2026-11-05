#!/usr/bin/env node
// The first job. It decides whether this run does anything at all, and reads only git objects
// and the event, so it never runs code from the branch and needs no secret.
//
//   ANALYSIS_OUT=<dir> analyze-pr.mjs
//
// Writes guard.json and analysis.json to that directory, and these step outputs: run, report,
// packages.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyzeChanges, readSourceDiff } from '../../.claude/skills/pr-change-analysis/scripts/analyze-changes.mjs';
import { requireEnv, setOutputs, writeJson } from './lib/github.mjs';

export const SKIP_LABEL = 'skip-test-agent';
export const BOT_TRAILER = 'Unit-Test-Agent-Run:';

/**
 * Decides from the event alone, before anything is read from the branch.
 * @returns {{ run: boolean, report: boolean, outcome?: string, reason?: string }}
 */
export function decideGuard({ event, headMessage }) {
  const pullRequest = event.pull_request;
  if (pullRequest.head.repo?.full_name !== event.repository.full_name) {
    // A fork gets no secret and a token that cannot comment, so the summary of the run is all it gets.
    return { run: false, report: true, outcome: 'fork', reason: 'Pull requests from forks do not run the agent.' };
  }
  if ((pullRequest.labels ?? []).some(({ name }) => name === SKIP_LABEL)) {
    return { run: false, report: true, outcome: 'skipped', reason: `The label ${SKIP_LABEL} asks to skip the agent.` };
  }
  // The last commit is the agent's own. Its report is already on the pull request.
  if (String(headMessage ?? '').split('\n').some((line) => line.startsWith(BOT_TRAILER))) {
    return { run: false, report: false, reason: 'The last commit came from the agent.' };
  }
  return { run: true, report: true };
}

function main(env = process.env) {
  const out = requireEnv('ANALYSIS_OUT', env);
  const event = JSON.parse(readFileSync(requireEnv('GITHUB_EVENT_PATH', env), 'utf8'));
  const repo = realpathSync(env.GITHUB_WORKSPACE ?? process.cwd());
  const pullRequest = event.pull_request;
  const headSha = pullRequest.head.sha;
  const headMessage = execFileSync('git', ['--no-pager', 'log', '-1', '--format=%B', headSha], { cwd: repo, encoding: 'utf8' });
  let guard = decideGuard({ event, headMessage });
  let analysis = null;
  if (guard.run) {
    analysis = analyzeChanges({ cwd: repo, base: pullRequest.base.sha, head: headSha });
    if (!analysis.decision.needs_agent) guard = { run: false, report: true, outcome: 'skipped' };
    else {
      const { text, chars, omitted } = readSourceDiff({ cwd: repo, analysis });
      analysis.source_diff = { chars, omitted };
      if (text !== null) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, 'source.diff'), text);
      }
    }
  } else if (guard.outcome === 'skipped') {
    analysis = { decision: { needs_agent: false, reason_code: 'label', reason: guard.reason } };
  }
  writeJson(join(out, 'guard.json'), guard);
  writeJson(join(out, 'analysis.json'), analysis);
  setOutputs({ run: guard.run, report: guard.report, packages: (analysis?.areas ?? []).join(',') }, env);
  process.stdout.write(`${JSON.stringify(guard)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`analyze-pr: ${error.message}\n`);
    process.exitCode = 1;
  }
}
