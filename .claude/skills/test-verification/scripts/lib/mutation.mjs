// Decides what Stryker mutates and reads what it found. A surviving mutant is a change to
// the code that no test noticed, so it shows behavior that passing tests do not check.
//
// Survivors never reject tests. Some mutants cannot change behavior at all, such as a guard
// that nothing can reach, so a threshold would reject good tests.

import { clean } from './sanitize-log.mjs';

// Above this the run would be slow and the list too long to act on.
export const MAX_CHANGED_LINES = 300;
export const MAX_FEEDBACK_MUTANTS = 20;

// On accepted tests in this repository, 51 of 84 survivors were of these kinds: labels,
// option objects and the like. They are reported, and they do not start a repair round.
export const DATA_MUTATORS = new Set(['StringLiteral', 'ObjectLiteral', 'ArrayDeclaration', 'Regex']);

// A path goes into a Stryker pattern, where other characters can mean something else.
const SAFE_PATH = /^[\w./@-]+$/;
// The feedback has a limit of its own, and 20 mutants must fit in it.
const MAX_SNIPPET = 80;

/** Turns sorted or unsorted line numbers into inclusive ranges of neighboring lines. */
export function toRanges(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges = [];
  for (const line of sorted) {
    const last = ranges.at(-1);
    if (last && last[1] === line - 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}

/**
 * Chooses what to mutate in each package.
 * @param {string[]} sourceFiles Repository-relative paths.
 * @param {Map<string, number[]>} [changedLines] Lines per file. Without it, whole files are mutated.
 * @returns {{ targets: Record<string, string[]>, skipped_paths: string[], changed_lines: number }}
 */
export function chooseTargets(sourceFiles, changedLines) {
  const targets = {};
  const skippedPaths = [];
  let count = 0;
  for (const path of sourceFiles) {
    const separator = path.indexOf('/');
    const packageName = path.slice(0, separator);
    const inPackage = path.slice(separator + 1);
    if (separator <= 0 || !SAFE_PATH.test(path)) {
      skippedPaths.push(path);
      continue;
    }
    const lines = changedLines?.get(path);
    if (changedLines && !lines?.length) continue;
    count += lines?.length ?? 0;
    const entries = lines ? toRanges(lines).map(([start, end]) => `${inPackage}:${start}-${end}`) : [inPackage];
    (targets[packageName] ??= []).push(...entries);
  }
  return { targets, skipped_paths: skippedPaths, changed_lines: count };
}

function snippet(source, { start, end }) {
  const lines = String(source ?? '').split('\n');
  const first = lines[start.line - 1] ?? '';
  const text = start.line === end.line ? first.slice(start.column - 1, end.column - 1) : `${first.slice(start.column - 1)} ...`;
  const collapsed = clean(text).replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SNIPPET ? `${collapsed.slice(0, MAX_SNIPPET)}...` : collapsed;
}

/** Reduces a Stryker JSON report to counts and the mutants no test caught. */
export function summarizeMutationReport(report, packageName) {
  const summary = { total: 0, caught: 0, survived: 0, no_coverage: 0, errors: 0, mutants: [] };
  for (const [file, entry] of Object.entries(report.files ?? {})) {
    for (const mutant of entry.mutants ?? []) {
      summary.total += 1;
      if (mutant.status === 'Killed' || mutant.status === 'Timeout') {
        summary.caught += 1;
      } else if (mutant.status === 'Survived' || mutant.status === 'NoCoverage') {
        summary[mutant.status === 'Survived' ? 'survived' : 'no_coverage'] += 1;
        summary.mutants.push({
          path: `${packageName}/${file}`,
          line: mutant.location.start.line,
          status: mutant.status,
          mutator: mutant.mutatorName,
          original: snippet(entry.source, mutant.location),
          replacement: clean(mutant.replacement ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET),
          data_only: DATA_MUTATORS.has(mutant.mutatorName),
        });
      } else {
        summary.errors += 1;
      }
    }
  }
  return summary;
}

/** The mutants worth a repair round, in a stable order. */
export function actionableMutants(mutation) {
  return (mutation?.mutants ?? [])
    .filter((mutant) => !mutant.data_only)
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/**
 * The text for the agent. It holds code from the branch, so the prompt places it in a data
 * tag. Returns null when there is nothing to act on.
 */
export function mutationFeedback(mutation) {
  const mutants = actionableMutants(mutation);
  if (mutants.length === 0) return null;
  const shown = mutants.slice(0, MAX_FEEDBACK_MUTANTS);
  const lines = shown.map(({ path, line, status, original, replacement }) => {
    const change = `\`${original}\` became \`${replacement}\``;
    return status === 'NoCoverage' ? `- ${path}:${line}: no test runs this code, for example ${change}` : `- ${path}:${line}: ${change}`;
  });
  if (mutants.length > shown.length) lines.push(`- and ${mutants.length - shown.length} more`);
  return [
    'The tests passed. Then the code was changed in each way below, one at a time, and no test failed. Nothing checks these behaviors yet.',
    ...lines,
  ].join('\n');
}
