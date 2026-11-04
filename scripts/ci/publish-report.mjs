#!/usr/bin/env node
// The last job. It always runs, so that a failure anywhere still gives a readable report. It
// runs no code from the branch. Everything it reads can come from a job that ran that code, and
// renderReport filters it. A failure to post is a warning, because a report must not block a merge.
//
//   ARTIFACTS=<dir> GITHUB_TOKEN=<token> publish-report.mjs

import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAgentDefinition, TOOLS_ROOT } from '../../.claude/lib/agent-definition.mjs';
import { skillsForSourceFiles } from '../../.claude/skills/pr-change-analysis/scripts/build-prompt.mjs';
import { renderReport, REPORT_MARKER } from '../../.claude/skills/pr-report/scripts/render-report.mjs';
import { chooseRound, readRounds } from './commit-tests.mjs';
import { readJson, requireEnv } from './lib/github.mjs';

export const CHECK_NAME = 'Unit test agent';
const BOT_LOGIN = 'github-actions[bot]';
const REQUEST_TIMEOUT_MS = 30000;
const addUp = (values) => {
  const numbers = values.filter(Number.isFinite);
  return numbers.length > 0 ? numbers.reduce((sum, value) => sum + value, 0) : undefined;
};

/**
 * Turns what the jobs left behind into the input of the report.
 * @param {object} state
 * @param {object} [state.guard] guard.json. Missing when the first job failed.
 * @param {object} [state.analysis] analysis.json.
 * @param {object} [state.regressionCheck] Output of check-regressions.
 * @param {{ record: object }[]} state.rounds Records of the rounds, in order.
 * @param {object} [state.commit] commit.json.
 * @param {boolean} [state.scanBlocked] The scan stopped the output of a round.
 */
export function buildReportInput({ guard, analysis, regressionCheck, rounds, commit, scanBlocked, headSha, runUrl, promptVersion, model, preloadedSkills }) {
  const base = { analysis, head_sha: headSha, run_url: runUrl, prompt_version: promptVersion, regression_check: regressionCheck ?? undefined };
  const records = rounds.map(({ record }) => record);
  const usage = {
    model: records.findLast(({ usage: used }) => used?.model)?.usage.model ?? model,
    turns: addUp(records.map(({ usage: used }) => used?.turns)),
    cost_usd: addUp(records.map(({ usage: used }) => used?.cost_usd)),
    blocked_calls: addUp(records.map(({ usage: used }) => used?.blocked_calls)),
  };
  if (!guard) return { ...base, outcome: 'agent_failed', failure_reason: 'The analysis of this pull request failed, so the agent did not run.', usage: { model } };
  if (!guard.run) return { ...base, outcome: guard.outcome ?? 'skipped', usage: { model } };

  const run = {
    ...base,
    usage,
    preloaded_skills: preloadedSkills,
    invoked_skills: [...new Set(records.flatMap(({ invoked_skills: skills }) => skills ?? []))],
    repair_rounds: Math.max(records.length - 1, 0),
  };
  // Whatever the rounds say, nothing from this run may be used after the key turned up in its output.
  if (scanBlocked) return { ...run, outcome: 'agent_failed', failure_reason: 'The output of the agent contained the API key, so nothing left its job and nothing was committed. Replace the key.' };
  const last = records.at(-1);
  if (!last) return { ...run, outcome: 'agent_failed', failure_reason: 'The agent left no result. This can be an API failure or a limit of the run.' };

  const chosen = chooseRound(rounds)?.record;
  if (chosen) {
    const accepted = { ...run, result: chosen.result, verification: chosen.verification, mutation: chosen.mutation };
    if (commit?.stale) return { ...accepted, outcome: 'stale' };
    const note = chosen !== last ? 'A later repair round did not pass, so the tests accepted earlier were kept.' : undefined;
    if (commit?.committed === false) return { ...accepted, outcome: 'tests_rejected', repair_note: `The commit step refused these tests: ${commit.reason ?? 'no reason given'}` };
    return { ...accepted, outcome: 'tests_added', commit_sha: commit?.commit_sha, repair_note: note };
  }
  return { ...run, outcome: last.outcome, result: last.result, verification: last.verification, failure_reason: last.failure_reason };
}

async function request(fetchFn, token, url, options = {}) {
  const response = await fetchFn(url, {
    ...options,
    // A server that never answers must end as a warning, and not hang until the job times out.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
  });
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${new URL(url).pathname} answered ${response.status}.`);
  return response.status === 204 ? null : response.json();
}

/** Finds the comment of an earlier run. Only one written by this bot counts, because anyone can paste the marker. */
export async function findStickyComment({ fetchFn, token, api, repository, number }) {
  for (let page = 1; page <= 10; page += 1) {
    const comments = await request(fetchFn, token, `${api}/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`);
    const found = comments.find((comment) => comment.user?.login === BOT_LOGIN && String(comment.body).startsWith(REPORT_MARKER));
    if (found) return found;
    if (comments.length < 100) return null;
  }
  return null;
}

/** Posts the comment and the check. Each failure is reported, and neither stops the other. */
export async function publish({ report, fetchFn, token, api, repository, number, sha, canPost }) {
  const warnings = [];
  if (!canPost) return warnings;
  try {
    const existing = await findStickyComment({ fetchFn, token, api, repository, number });
    const body = JSON.stringify({ body: report.markdown });
    if (existing) await request(fetchFn, token, `${api}/repos/${repository}/issues/comments/${existing.id}`, { method: 'PATCH', body });
    else await request(fetchFn, token, `${api}/repos/${repository}/issues/${number}/comments`, { method: 'POST', body });
  } catch (error) {
    warnings.push(`The comment was not posted: ${error.message}`);
  }
  try {
    await request(fetchFn, token, `${api}/repos/${repository}/check-runs`, {
      method: 'POST',
      body: JSON.stringify({ name: CHECK_NAME, head_sha: sha, status: 'completed', conclusion: report.conclusion, output: { title: report.title, summary: report.markdown } }),
    });
  } catch (error) {
    warnings.push(`The check was not posted: ${error.message}`);
  }
  return warnings;
}

async function main(env = process.env) {
  const artifacts = requireEnv('ARTIFACTS', env);
  const event = JSON.parse(readFileSync(requireEnv('GITHUB_EVENT_PATH', env), 'utf8'));
  const pullRequest = event.pull_request;
  const definition = readAgentDefinition(TOOLS_ROOT);
  const analysis = readJson(join(artifacts, 'analysis/analysis.json'));
  const guard = readJson(join(artifacts, 'analysis/guard.json'));
  const commit = readJson(join(artifacts, 'commit/commit.json'));
  const input = buildReportInput({
    guard,
    analysis,
    regressionCheck: readJson(join(artifacts, 'baseline/regressions.json')),
    rounds: readRounds(artifacts),
    commit,
    scanBlocked: env.SCAN_BLOCKED === 'true',
    headSha: pullRequest.head.sha,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    promptVersion: definition.promptVersion,
    model: definition.model,
    preloadedSkills: skillsForSourceFiles(analysis?.source_files ?? [], TOOLS_ROOT),
  });
  const report = renderReport(input);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${report.markdown}\n`);
  // A fork has a token that cannot comment, and the summary above is the report it gets.
  const warnings = await publish({
    report,
    fetchFn: fetch,
    token: env.GITHUB_TOKEN,
    api: env.GITHUB_API_URL ?? 'https://api.github.com',
    repository: env.GITHUB_REPOSITORY,
    number: pullRequest.number,
    sha: commit?.commit_sha ?? pullRequest.head.sha,
    canPost: input.outcome !== 'fork',
  });
  for (const warning of warnings) process.stdout.write(`::warning::${warning}\n`);
  process.stdout.write(`Check result: ${report.conclusion}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    // Not even a report could be built. This is the one case where the job shows red.
    process.stderr.write(`publish-report: ${error.message}\n`);
    process.exitCode = 1;
  });
}

