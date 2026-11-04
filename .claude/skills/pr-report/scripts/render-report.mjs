#!/usr/bin/env node
// Builds the report from structured data, always through the same template. Text that
// comes from the model or the pull request passes through safeText or safeCode, so it
// cannot mention people, add HTML or links, or reach the comment as raw output.
//
//   render-report.mjs --input <file> [--json]
//
// With --json it prints { conclusion, title, markdown } for the workflow to use.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { clean } from '../../test-verification/scripts/lib/sanitize-log.mjs';

export const REPORT_MARKER = '<!-- unit-test-agent-report -->';
export const SOURCE_NOTE = 'Test descriptions and possible bugs are reported by the agent and not verified. Test results, coverage and the check result come from the gate.';
export const MAX_REPORT_LENGTH = 60000;
const MAX_LIST_ITEMS = 30;
const MAX_MUTANTS_IN_REPORT = 10;
const RUN_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/;

export const OUTCOMES = [
  'tests_added',
  'no_tests_needed',
  'skipped',
  'tests_rejected',
  'agent_failed',
  'stale',
  'fork',
];

/** Makes untrusted text safe to place in Markdown outside a code span. */
export function safeText(value, limit = 500) {
  const collapsed = clean(value).replace(/\s+/g, ' ').trim();
  const shortened = collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
  return shortened
    .replace(/@/g, '')
    .replace(/([a-z][a-z0-9+.-]*):\/\//gi, '$1[:]//')
    .replace(/\bwww\./gi, 'www[.]')
    .replace(/#(?=\d)/g, '# ')
    .replace(/[\\`*_{}[\]()<>!|~&]/g, '\\$&');
}

/** Makes an untrusted path or test name safe as a code span, also inside a table cell. */
export function safeCode(value, limit = 200) {
  const collapsed = clean(value).replace(/\s+/g, ' ').trim();
  const shortened = collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
  if (shortened === '') return '`(empty)`';
  // The sticky comment is found by its marker, so no other copy of a comment opener may appear.
  return `\`${shortened.replace(/`/g, "'").replace(/\|/g, '\\|').replace(/<!--/g, '< !--')}\``;
}

/** Only the link to a run of this kind may become a link. Anything else is dropped. */
export function safeRunUrl(value) {
  return typeof value === 'string' && RUN_URL.test(value) ? value : null;
}

/** Only a real regression turns the check red. A failure of the agent must never block a merge. */
export function conclusionFor(input) {
  if ((input.regression_check?.regressions ?? []).length > 0) return 'failure';
  if (['tests_added', 'no_tests_needed'].includes(input.outcome)) return 'success';
  if (input.outcome === 'skipped' && input.analysis?.decision?.reason_code !== 'too_large') return 'success';
  return 'neutral';
}

const countTests = (count) => `${count} ${count === 1 ? 'test' : 'tests'}`;

function headline(input) {
  const tests = countTests(input.result?.tests?.length ?? 0);
  switch (input.outcome) {
    case 'tests_added':
      return input.commit_sha ? `${tests} added to this pull request` : `${tests} written and verified`;
    case 'no_tests_needed':
      return 'No tests needed';
    case 'skipped':
      return input.analysis?.decision?.reason_code === 'too_large' ? 'Skipped: this change is too large' : 'No tests needed';
    case 'tests_rejected':
      return 'Tests rejected by the gate, nothing was committed';
    case 'agent_failed':
      return 'The agent could not finish, nothing was committed';
    case 'stale':
      return 'Result discarded: a newer commit arrived';
    case 'fork':
      return 'Skipped: pull requests from forks do not run the agent';
    default:
      return 'Unknown result';
  }
}

function explanation(input) {
  switch (input.outcome) {
    case 'tests_added':
    case 'no_tests_needed':
      return safeText(input.result?.reasoning, 1000);
    case 'skipped':
      return safeText(input.analysis?.decision?.reason, 500);
    case 'agent_failed':
      return `${safeText(input.failure_reason ?? 'The run ended without a valid result.', 300)} This does not block the pull request.`;
    case 'tests_rejected':
      return 'The agent\'s tests did not pass the checks below. This does not block the pull request.';
    case 'stale':
      return 'The pull request moved on while this run was working. The run for the newest commit reports instead.';
    case 'fork':
      return 'The agent needs a secret, and GitHub does not expose secrets to forks. Regular CI still runs.';
    default:
      return '';
  }
}

function limited(items, render) {
  const lines = items.slice(0, MAX_LIST_ITEMS).map(render);
  if (items.length > MAX_LIST_ITEMS) lines.push(`- and ${items.length - MAX_LIST_ITEMS} more, see the run artifact`);
  return lines;
}

function section(title, lines) {
  return lines.length > 0 ? [`#### ${title}`, '', ...lines, ''] : [];
}

const checkLabel = (passed) => (passed ? 'passed' : '**failed**');

function testResultRows(packages) {
  const rows = [];
  for (const [name, entry] of Object.entries(packages)) {
    const newTests = entry.new_tests
      ? `${entry.new_tests.total} tests, ${entry.new_tests.runs} runs: ${checkLabel(entry.new_tests.passed)}`
      : 'none';
    const full = entry.full_package ? `${entry.full_package.total} tests: ${checkLabel(entry.full_package.passed)}` : 'not run';
    const typecheck = entry.typecheck ? checkLabel(entry.typecheck.passed) : 'not run';
    rows.push(`| ${safeCode(name)} | ${newTests} | ${full} | ${typecheck} |`);
  }
  return rows.length > 0 ? ['| Package | Changed test files | Whole package | Typecheck |', '|---|---|---|---|', ...rows] : [];
}

const percent = (metric) => (Number.isFinite(metric?.pct) ? `${metric.pct}%` : 'n/a');

function coverageRows(packages) {
  const rows = [];
  for (const [name, entry] of Object.entries(packages)) {
    const total = entry.coverage?.total;
    if (!total) continue;
    rows.push(`| ${safeCode(`${name} (package)`)} | ${percent(total.before?.lines)} | ${percent(total.after?.lines)} | ${percent(total.before?.branches)} | ${percent(total.after?.branches)} | |`);
    for (const file of entry.coverage.files ?? []) {
      const changed = file.changed_lines ? `${file.changed_lines.covered}/${file.changed_lines.total}` : 'n/a';
      rows.push(`| ${safeCode(file.path)} | ${percent(file.before?.lines)} | ${percent(file.after?.lines)} | ${percent(file.before?.branches)} | ${percent(file.after?.branches)} | ${changed} |`);
    }
  }
  if (rows.length === 0) return [];
  return ['| | Lines before | Lines after | Branches before | Branches after | Changed lines covered |', '|---|---|---|---|---|---|', ...rows.slice(0, MAX_LIST_ITEMS * 2)];
}

function gateFailures(failures) {
  return limited(failures, (failure) => {
    const where = failure.package ? ` in ${safeCode(failure.package)}` : '';
    const details = [
      ...(failure.tests ?? []).map(({ id }) => safeCode(id)),
      ...(failure.violations ?? []).map(({ rule, path }) => `${safeCode(rule)} in ${safeCode(path)}`),
      ...(failure.paths ?? []).map(({ path, reason }) => `${safeCode(path)} ${safeText(reason, 100)}`),
    ];
    const shown = details.slice(0, 10).join(', ');
    const more = details.length > 10 ? `, and ${details.length - 10} more` : '';
    // The log and the failure messages come from running the branch, so they stay in the artifact.
    return `- ${safeCode(failure.check)}${where}: ${safeText(failure.message, 200)}${shown ? ` ${shown}${more}` : ''}`;
  });
}

const MUTATION_NOT_RUN = {
  timed_out: 'hit the time limit, so there is no result',
  failed: 'could not run, see the run artifact',
};

/** What the mutation check found. It is a warning and has no part in the check result. */
function mutationLines(mutation) {
  if (!mutation) return [];
  if (mutation.status === 'skipped') return [`Not run. ${safeText(mutation.reason, 200)}`];
  const packages = Object.entries(mutation.packages ?? {}).map(([name, entry]) => {
    if (MUTATION_NOT_RUN[entry.status]) return `- ${safeCode(name)} ${MUTATION_NOT_RUN[entry.status]}.`;
    const missed = entry.survived + entry.no_coverage;
    return `- ${safeCode(name)}: ${entry.caught} of ${entry.total} changes to the changed lines made a test fail, ${missed} did not.`;
  });
  const skipped = mutation.skipped_paths ?? [];
  if (skipped.length > 0) packages.push(`- Not checked, because of unusual file names: ${skipped.slice(0, 5).map((path) => safeCode(path)).join(', ')}`);
  const mutants = mutation.mutants ?? [];
  const behavior = mutants.filter(({ data_only: dataOnly }) => !dataOnly);
  const listed = behavior.slice(0, MAX_MUTANTS_IN_REPORT).map(({ path, line, original, replacement }) => `- ${safeCode(`${path}:${line}`)}: ${safeCode(original)} became ${safeCode(replacement)}`);
  if (behavior.length > listed.length) listed.push(`- and ${behavior.length - listed.length} more, see the run artifact`);
  const dataOnly = mutants.length - behavior.length;
  if (dataOnly > 0) listed.push(`- ${dataOnly} more changed only text or data, see the run artifact`);
  const heading = behavior.length > 0 ? ['', 'No test noticed these changes to the code, so these behaviors may be unchecked. This is a warning and does not block the pull request:', ''] : [];
  return [...packages, ...heading, ...listed];
}

function runFacts(input) {
  const facts = [];
  const runUrl = safeRunUrl(input.run_url);
  if (runUrl) facts.push(`[Run and logs](${runUrl})`);
  facts.push(`Commit ${safeCode(String(input.head_sha ?? 'unknown').slice(0, 12))}`);
  if (input.commit_sha) facts.push(`Test commit ${safeCode(String(input.commit_sha).slice(0, 12))}`);
  facts.push(`Model ${safeCode(input.usage?.model ?? 'unknown')}`);
  facts.push(`Prompt version ${safeCode(input.prompt_version ?? 'unknown')}`);
  if (input.repair_rounds > 0) facts.push(`${input.repair_rounds} repair ${input.repair_rounds === 1 ? 'round' : 'rounds'}`);
  if (Number.isFinite(input.usage?.turns)) facts.push(`${input.usage.turns} turns`);
  if (Number.isFinite(input.usage?.cost_usd)) facts.push(`$${input.usage.cost_usd.toFixed(4)}`);
  // A blocked call can be an honest mistake or the sign of an injection attempt.
  if (input.usage?.blocked_calls > 0) facts.push(`${input.usage.blocked_calls} blocked tool ${input.usage.blocked_calls === 1 ? 'call' : 'calls'}`);
  return facts.join(' · ');
}

/**
 * Renders the report.
 * @param {object} input
 * @param {string} input.outcome One of OUTCOMES.
 * @param {object} [input.analysis] Output of analyze-changes.
 * @param {object} [input.result] The validated agent result.
 * @param {object} [input.verification] Output of verify-tests.
 * @param {string[]} [input.preloaded_skills] Skills that code placed in the prompt.
 * @param {string[]} [input.invoked_skills] Skills the transcript shows the agent calling.
 * @param {{ regressions: string[], baseline_red?: string[] }} [input.regression_check]
 * @param {{ model?: string, turns?: number, cost_usd?: number, blocked_calls?: number }} [input.usage]
 * @param {object} [input.mutation] Output of mutate-changed-lines. A warning, never part of the conclusion.
 * @param {number} [input.repair_rounds] Attempts after the first one.
 * @param {string} [input.repair_note] Why the tests in the report come from an earlier attempt.
 */
export function renderReport(input) {
  if (!OUTCOMES.includes(input.outcome)) throw new Error('Unknown outcome.');
  const conclusion = conclusionFor(input);
  const title = headline(input);
  const { result, verification, regression_check: regressionCheck } = input;
  const packages = verification?.packages ?? {};
  const regressions = regressionCheck?.regressions ?? [];
  const lines = [REPORT_MARKER, `### Unit test agent: ${title}`, '', explanation(input), ''];
  if (input.repair_note) lines.push(safeText(input.repair_note, 400), '');

  if (regressions.length > 0) {
    lines.push(
      ...section('Regression: existing tests pass on the base commit and fail on this commit', limited(regressions, (id) => `- ${safeCode(id)}`)),
    );
  }
  lines.push(...section('Gate failures', gateFailures(verification?.failures ?? [])));
  lines.push(...section('New tests', limited(result?.tests ?? [], ({ file, name, behavior }) => `- ${safeCode(file)} ${safeCode(name)}: ${safeText(behavior, 300)}`)));
  lines.push(
    ...section(
      'Possible bugs reported by the agent',
      limited(result?.suspected_bugs ?? [], ({ file, expected, actual }) => `- ${safeCode(file)}: expected ${safeText(expected, 300)}, actual ${safeText(actual, 300)}`),
    ),
  );
  lines.push(
    ...section(
      'Existing tests changed',
      limited(result?.existing_tests_changed ?? [], ({ path, justification }) => `- ${safeCode(path)}: ${safeText(justification, 300)}`),
    ),
  );
  lines.push(
    ...section(
      'Shared test support changed (the whole package ran)',
      limited(verification?.shared_test_support ?? [], (path) => `- ${safeCode(path)}`),
    ),
  );
  lines.push(...section('Test results', testResultRows(packages)));
  lines.push(...section('Coverage', coverageRows(packages)));
  lines.push(...section('Mutation check', mutationLines(input.mutation)));

  const baselineRed = [
    ...(regressionCheck?.baseline_red ?? []),
    ...Object.values(packages).flatMap((entry) => entry.full_package?.baseline_failures ?? []),
  ];
  lines.push(...section('Already failing before this run (not caused by the agent)', limited([...new Set(baselineRed)], (id) => `- ${safeCode(id)}`)));

  const flags = input.analysis?.flags;
  lines.push(...section('Symbolic links changed in this pull request', limited(flags?.symlinks ?? [], (path) => `- ${safeCode(path)}`)));

  const skillList = (skills) => (skills?.length > 0 ? skills.map((skill) => safeCode(skill)).join(', ') : 'none');
  if (input.preloaded_skills || input.invoked_skills) {
    lines.push(`Skills preloaded: ${skillList(input.preloaded_skills)}. Skills invoked: ${skillList(input.invoked_skills)}.`, '');
  }
  if (result) lines.push(SOURCE_NOTE, '');
  lines.push(`<sub>${runFacts(input)}</sub>`, '');

  let markdown = lines.join('\n');
  if (markdown.length > MAX_REPORT_LENGTH) {
    markdown = `${markdown.slice(0, MAX_REPORT_LENGTH)}\n\nThe report was cut. See the run artifact.\n`;
  }
  return { conclusion, title, markdown };
}

function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, json: { type: 'boolean', default: false } } });
  if (!values.input) throw new Error('Usage: render-report.mjs --input <file> [--json]');
  const report = renderReport(JSON.parse(readFileSync(values.input, 'utf8')));
  process.stdout.write(values.json ? `${JSON.stringify(report)}\n` : report.markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`render-report: ${error.message}\n`);
    process.exitCode = 2;
  }
}
