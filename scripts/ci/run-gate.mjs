#!/usr/bin/env node
// One round of the gate, in a job with no secret. It runs code from the branch, so what it writes
// can be forged. That is why the commit job checks everything again, and the report only
// shows this data through its filter.
//
//   ROUND=<n> ARTIFACTS=<dir> OUT=<dir> run-gate.mjs
//
// ARTIFACTS holds analysis/, baseline/, agent-round-<n>/ and, after the first round,
// gate-round-<n-1>/. Writes round.json and gate.patch. Step output: next, which is empty, "gate"
// or "mutation". It exits with 0 whatever the tests do, because a rejected attempt is a result.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTranscript } from '../../.claude/skills/pr-report/scripts/read-transcript.mjs';
import { mutationFeedback } from '../../.claude/skills/test-verification/scripts/lib/mutation.mjs';
import { gateFeedback, MAX_MUTATION_ROUNDS, MAX_REPAIR_ROUNDS, nextRepair } from '../../.claude/skills/test-verification/scripts/lib/repair-round.mjs';
import { runMutation } from '../../.claude/skills/test-verification/scripts/mutate-changed-lines.mjs';
import { runVerify } from '../../.claude/skills/test-verification/scripts/verify-tests.mjs';
import { decideOutcome, interpretRun } from '../test-agent.mjs';
import { readJson, requireEnv, setOutputs, writeJson } from './lib/github.mjs';
import { applyPatch, collectPatch } from './lib/patch.mjs';

/** With no transcript, nothing shows that a model ran, so the report must not suggest an API failure. */
const noTranscriptReason = (actionOutcome) => (actionOutcome === 'skipped'
  ? 'The attempt did not start, because preparing it failed. The log of the run has the cause.'
  : 'The agent left no transcript, so it most likely never started. The log of the run has the cause.');

const refusedVerification = (message, paths) => ({
  schema_version: 1,
  status: 'failed',
  changed_files: [],
  shared_test_support: [],
  existing_tests_changed: [],
  modified_test_files: [],
  new_tests: [],
  packages: {},
  failures: [{ check: 'scope', message, paths }],
});

/**
 * Runs one round.
 * @param {object} options
 * @param {string} options.repo A clean checkout of the pull request, with dependencies installed.
 * @param {number} options.round The attempt, from 0.
 * @param {object} options.analysis Output of analyze-changes.
 * @param {object} [options.baseline] Output of verify-tests baseline.
 * @param {object} options.agent agent.json from the job with the key.
 * @param {string} options.transcriptText The transcript, or an empty string.
 * @param {string} options.patchFile agent.patch.
 * @param {object} [options.previous] round.json of the previous attempt.
 * @param {string} options.gatePatch Where to write the patch after formatting.
 */
export function runGateRound({ repo, round, analysis, baseline, agent, transcriptText, patchFile, previous, gatePatch, deps = {} }) {
  const { verify = runVerify, mutate = runMutation } = deps;
  const transcript = readTranscript(transcriptText);
  const mutationRounds = (previous?.mutation_rounds ?? 0) + (previous?.next === 'mutation' ? 1 : 0);
  const record = {
    schema_version: 1,
    round,
    mutation_rounds: mutationRounds,
    usage: { model: transcript.model, turns: transcript.turns, cost_usd: transcript.costUsd, blocked_calls: transcript.denials },
    invoked_skills: transcript.skills,
    removed_instruction_files: agent.removed_instruction_files ?? [],
    outcome: null,
    accepted: false,
    next: '',
    feedback: null,
  };
  if (transcriptText.trim() === '') return { ...record, result: null, outcome: 'agent_failed', failure_reason: noTranscriptReason(agent.action_outcome) };
  const run = { status: agent.action_outcome === 'success' ? 0 : 1, timedOut: false, startError: null };
  const { failureReason, result } = interpretRun({ run, transcript });
  record.result = result;
  if (failureReason) return { ...record, outcome: 'agent_failed', failure_reason: failureReason };

  let verification;
  if (agent.outside.length > 0) {
    verification = refusedVerification(`The agent changed ${agent.outside.length} path(s) outside the allowlist. Nothing was run.`, agent.outside.map((path) => ({ path, reason: 'is outside the test allowlist' })));
  } else if (statSync(patchFile).size > 0) {
    const { applied, problems } = applyPatch(repo, patchFile);
    if (!applied) verification = refusedVerification(`The patch from the agent was refused with ${problems.length} problem(s). Nothing was run.`, problems);
  }
  verification ??= verify({ repo, mergeBase: analysis.merge_base, sourceFiles: analysis.source_files, baseline });

  const outcome = decideOutcome({ result, verification });
  let mutation;
  if (outcome === 'tests_added') mutation = mutate({ repo, sourceFiles: analysis.source_files, mergeBase: analysis.merge_base });
  // The next attempt continues from these tests, also when they were rejected. Formatting by
  // the gate is in here too, so a commit gets the formatted files.
  collectPatch(repo, gatePatch);

  const next = nextRepair({ outcome, mutation, round, maxRounds: MAX_REPAIR_ROUNDS, mutationRounds, maxMutationRounds: MAX_MUTATION_ROUNDS });
  let feedback = null;
  if (next === 'gate') feedback = gateFeedback(verification);
  if (next === 'mutation') feedback = mutationFeedback(mutation);
  return { ...record, outcome, verification, mutation, accepted: outcome === 'tests_added', next: next ?? '', feedback };
}

function main(env = process.env) {
  const repo = realpathSync(env.GITHUB_WORKSPACE ?? process.cwd());
  const round = Number(requireEnv('ROUND', env));
  const artifacts = requireEnv('ARTIFACTS', env);
  const out = requireEnv('OUT', env);
  mkdirSync(out, { recursive: true });
  const agentDir = join(artifacts, `agent-round-${round}`);
  const transcriptPath = join(agentDir, 'transcript.json');
  const record = runGateRound({
    repo,
    round,
    analysis: readJson(join(artifacts, 'analysis/analysis.json')),
    baseline: readJson(join(artifacts, 'baseline/baseline.json')),
    agent: readJson(join(agentDir, 'agent.json')),
    transcriptText: existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : '',
    patchFile: join(agentDir, 'agent.patch'),
    previous: round > 0 ? readJson(join(artifacts, `gate-round-${round - 1}/round.json`)) : undefined,
    gatePatch: join(out, 'gate.patch'),
  });
  writeJson(join(out, 'round.json'), record);
  setOutputs({ next: record.next, outcome: record.outcome, accepted: record.accepted }, env);
  process.stdout.write(`Round ${round}: ${record.outcome}. Next: ${record.next || 'none'}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`run-gate: ${error.message}\n`);
    process.exitCode = 1;
  }
}
