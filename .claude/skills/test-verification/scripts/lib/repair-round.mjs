// Decides whether the agent gets another attempt, and what it is told. The local runner and
// the workflow use the same rules.

import { actionableMutants } from './mutation.mjs';
import { sanitizeLog } from './sanitize-log.mjs';

export const MAX_REPAIR_ROUNDS = 2;
// A mutant that cannot change behavior can never be caught, so another round would not help.
export const MAX_MUTATION_ROUNDS = 1;
// Off unless asked for. A repair round for mutants has not been shown to work on a real run,
// so by default a survivor is only a warning in the report.
export const DEFAULT_MUTATION_ROUNDS = 0;

const MAX_TESTS_PER_FAILURE = 5;
const MAX_LOG_PER_FAILURE = 1000;

/**
 * @param {object} state
 * @param {string} state.outcome The outcome of the attempt that just ended.
 * @param {object} [state.mutation] The mutation result of that attempt.
 * @param {number} state.round Repair rounds used so far.
 * @param {number} state.maxRounds Repair rounds allowed.
 * @param {number} state.mutationRounds Repair rounds used so far because of mutants.
 * @param {number} [state.maxMutationRounds] Repair rounds allowed because of mutants.
 * @returns {'gate' | 'mutation' | null} Why to run again, or null to stop.
 */
export function nextRepair({ outcome, mutation, round, maxRounds, mutationRounds, maxMutationRounds = DEFAULT_MUTATION_ROUNDS }) {
  if (round >= maxRounds) return null;
  if (outcome === 'tests_rejected') return 'gate';
  if (outcome === 'tests_added' && mutationRounds < Math.min(maxMutationRounds, MAX_MUTATION_ROUNDS) && actionableMutants(mutation).length > 0) return 'mutation';
  return null;
}

/** What the gate rejected, for the agent. Logs come from running the branch, so the prompt marks this as data. */
export function gateFeedback(verification) {
  const sections = (verification.failures ?? []).map((failure) => {
    const lines = [`${failure.check}${failure.package ? ` in ${failure.package}` : ''}: ${failure.message}`];
    for (const { id, message } of (failure.tests ?? []).slice(0, MAX_TESTS_PER_FAILURE)) lines.push(`- ${id}${message ? `\n${message}` : ''}`);
    if ((failure.tests?.length ?? 0) > MAX_TESTS_PER_FAILURE) lines.push(`- and ${failure.tests.length - MAX_TESTS_PER_FAILURE} more`);
    for (const { rule, path, line, message } of failure.violations ?? []) lines.push(`- ${rule} in ${path}${line ? `:${line}` : ''}: ${message}`);
    for (const { path, reason } of failure.paths ?? []) lines.push(`- ${path} ${reason}`);
    if (failure.log) lines.push(sanitizeLog(failure.log, MAX_LOG_PER_FAILURE));
    return lines.join('\n');
  });
  return ['The gate rejected the tests from the previous attempt.', ...sections].join('\n\n');
}
