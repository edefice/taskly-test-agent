#!/usr/bin/env node
// Prepares one attempt of the agent, in the job that has the key. It runs only tools from the
// base commit and no code from the branch. For a repair round it first puts back the tests of the
// previous attempt, under the same check as any other patch.
//
//   ROUND=<n> ARTIFACTS=<dir> prepare-agent.mjs
//
// Step outputs: prompt, claude_args. ARTIFACTS holds analysis/analysis.json and, for a repair
// round, gate-round-<n-1>/round.json and gate.patch from the previous attempt.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TOOLS_ROOT } from '../../.claude/lib/agent-definition.mjs';
import { buildDiffPrompt } from '../../.claude/skills/pr-change-analysis/scripts/build-prompt.mjs';
import { claudeArgs, DEFAULT_MAX_TURNS } from '../test-agent.mjs';
import { readJson, requireEnv, setOutputs } from './lib/github.mjs';
import { applyPatch } from './lib/patch.mjs';

export const MAX_BUDGET_USD = 0.75;

const WITHOUT_VALUE = new Set(['--verbose']);
// The action sets these itself, and it takes the prompt as an input.
const SET_BY_THE_ACTION = new Set(['-p', '--output-format']);

/** Quotes one argument for shell-quote, which the action uses to read claude_args. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

/** Turns the arguments of a local run into the claude_args input of the action. */
export function actionClaudeArgs(repo) {
  const args = claudeArgs({ prompt: '', repo, maxTurns: DEFAULT_MAX_TURNS, maxBudgetUsd: MAX_BUDGET_USD, noBash: true });
  const kept = [];
  for (let index = 0; index < args.length; index += 1) {
    if (SET_BY_THE_ACTION.has(args[index])) index += 1;
    else if (!WITHOUT_VALUE.has(args[index])) kept.push(args[index]);
  }
  // So that the transcript of a run shows the guard hook firing under the action.
  kept.push('--include-hook-events');
  return kept.map(shellQuote).join(' ');
}

/**
 * @returns {{ prompt: string, claudeArgs: string }}
 * Throws when the tests of the previous attempt cannot be put back.
 */
export function prepareAgent({ repo, round, artifacts, root = TOOLS_ROOT }) {
  const analysis = readJson(join(artifacts, 'analysis/analysis.json'));
  if (!analysis) throw new Error('There is no analysis.');
  let feedback;
  if (round > 0) {
    const previous = join(artifacts, `gate-round-${round - 1}`);
    feedback = readJson(join(previous, 'round.json'))?.feedback;
    if (!feedback) throw new Error('A repair round has no feedback.');
    const patch = join(previous, 'gate.patch');
    if (existsSync(patch) && statSync(patch).size > 0) {
      const { applied, problems } = applyPatch(repo, patch);
      if (!applied) throw new Error(`The previous attempt cannot be put back: ${problems.length} problem(s).`);
    }
  }
  const prompt = buildDiffPrompt({ analysis, feedback, repair: round > 0, root });
  return { prompt, claudeArgs: actionClaudeArgs(repo) };
}

function main(env = process.env) {
  const repo = realpathSync(env.GITHUB_WORKSPACE ?? process.cwd());
  const round = Number(requireEnv('ROUND', env));
  if (!Number.isInteger(round) || round < 0) throw new Error('ROUND must be a whole number.');
  const { prompt, claudeArgs: args } = prepareAgent({ repo, round, artifacts: requireEnv('ARTIFACTS', env) });
  setOutputs({ prompt, claude_args: args }, env);
  process.stdout.write(`Prepared round ${round}: a prompt of ${prompt.length} characters.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`prepare-agent: ${error.message}\n`);
    process.exitCode = 1;
  }
}
