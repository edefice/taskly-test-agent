#!/usr/bin/env node
// Runs the same pipeline as the pull request workflow on this machine:
// analysis, baseline, agent, gate, report. It never commits, so the tests stay in the
// working tree for review.
//
//   npm run test-agent -- --base main [--dry-run] [--no-bash]
//   npm run test-agent -- --files backend/src/api/health.ts,frontend/src/lib/http.ts
//   npm run test-agent -- --files backend/src/api/health.ts --feedback why-rejected.txt
//   npm run test-agent -- --base main --repair-rounds 2
//
// --dry-run needs no API key and does not run the agent or the tests.
// --no-bash removes Bash from the agent, as in CI.
// --feedback gives the agent a file that says why a previous attempt was rejected. It reaches
// the agent as data, so describe what is wrong. A copy stays in the artifacts.
// --no-mutation skips the mutation check that follows an accepted run.
// --repair-rounds gives the agent more attempts, at most 2, when the gate rejects its
// tests. The default is 0, because each round costs money.
// --mutation-repair lets one of those rounds answer surviving mutants. Without it, a survivor
// is only a warning in the report.
//
// Bash runs tests written by the agent on this machine, so use this on your own code only.
//
// Exit codes: 0 tests accepted, none needed, or nothing to do. 1 rejected or the agent
// failed. 2 could not start.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { AGENT_NAME, readAgentDefinition, TOOLS_ROOT } from '../.claude/lib/agent-definition.mjs';
import { buildDiffPrompt, buildFilesPrompt, skillsForSourceFiles } from '../.claude/skills/pr-change-analysis/scripts/build-prompt.mjs';
import { analyzeChanges, classifyKind } from '../.claude/skills/pr-change-analysis/scripts/analyze-changes.mjs';
import { readTranscript } from '../.claude/skills/pr-report/scripts/read-transcript.mjs';
import { renderReport } from '../.claude/skills/pr-report/scripts/render-report.mjs';
import { AGENT_RESULT_SCHEMA, crossCheckWithVerification, validateResult } from '../.claude/skills/pr-report/scripts/validate-result.mjs';
import { mutationFeedback } from '../.claude/skills/test-verification/scripts/lib/mutation.mjs';
import { DEFAULT_MUTATION_ROUNDS, gateFeedback, MAX_MUTATION_ROUNDS, MAX_REPAIR_ROUNDS, nextRepair } from '../.claude/skills/test-verification/scripts/lib/repair-round.mjs';
import { runMutation } from '../.claude/skills/test-verification/scripts/mutate-changed-lines.mjs';
import { PACKAGES, runBaseline, runVerify } from '../.claude/skills/test-verification/scripts/verify-tests.mjs';

export const ARTIFACTS_DIR = '.test-agent';
export const DEFAULT_MAX_TURNS = 40;
export const DEFAULT_MAX_BUDGET_USD = 1;
// onFailure: "block" on the hook needs this version. Older versions let tools through when it fails.
export const MINIMUM_CLAUDE_VERSION = [2, 1, 295];
const AGENT_TIMEOUT_MS = 20 * 60 * 1000;

const FAILURE_REASONS = {
  error_max_turns: 'The agent reached the turn limit.',
  error_max_budget_usd: 'The agent reached the budget limit.',
  error_during_execution: 'The agent stopped because of an execution error.',
};

class UsageError extends Error {}

export function isSupportedVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  if (!match) return false;
  const version = match.slice(1).map(Number);
  for (const [index, minimum] of MINIMUM_CLAUDE_VERSION.entries()) {
    if (version[index] !== minimum) return version[index] > minimum;
  }
  return true;
}

/**
 * Permissions are given per run. A bare Read, Grep or Glob in --allowedTools would open every
 * file on the machine. --tools only chooses tools and approves nothing. It is needed because
 * Claude Code otherwise drops Grep and Glob when Bash is present, and searches through Bash,
 * which the hook blocks.
 */
export function claudeArgs({ prompt, repo, maxTurns, maxBudgetUsd, noBash, tools = readAgentDefinition(TOOLS_ROOT).tools }) {
  const allowed = ['Edit', 'Write'];
  if (!noBash) allowed.push('Bash(npm --prefix backend run *)', 'Bash(npm --prefix frontend run *)');
  return [
    '-p',
    prompt,
    '--agent',
    AGENT_NAME,
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(AGENT_RESULT_SCHEMA),
    '--max-turns',
    String(maxTurns),
    '--max-budget-usd',
    String(maxBudgetUsd),
    '--setting-sources',
    'project',
    '--settings',
    join(repo, '.claude/agent-run.settings.json'),
    '--tools',
    tools.filter((tool) => !(noBash && tool === 'Bash')).join(','),
    '--allowedTools',
    allowed.join(','),
    ...(noBash ? ['--disallowedTools', 'Bash'] : []),
  ];
}

/** The hook enforces its rules through this switch even if a session reports no agent name. */
export function claudeEnv(env = process.env) {
  return { ...env, UNIT_TEST_AGENT_ENFORCE: '1', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' };
}

function runClaude({ args, repo, transcriptPath }) {
  const output = openSync(transcriptPath, 'w');
  try {
    const result = spawnSync('claude', args, {
      cwd: repo,
      env: claudeEnv(),
      stdio: ['ignore', output, 'inherit'],
      timeout: AGENT_TIMEOUT_MS,
    });
    return { status: result.status, timedOut: result.error?.code === 'ETIMEDOUT', startError: result.error && result.error.code !== 'ETIMEDOUT' ? result.error.message : null };
  } finally {
    closeSync(output);
  }
}

function claudeVersion() {
  const result = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

const git = (repo, args) => {
  const result = spawnSync('git', ['--no-pager', ...args], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new UsageError(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
};

function validateFiles(repo, files) {
  for (const path of files) {
    if (classifyKind(path) !== 'source') throw new UsageError(`Not a source file: ${path}`);
    if (!existsSync(join(repo, path))) throw new UsageError(`No such file: ${path}`);
  }
}

/** Fails before anything is spent. An empty file is a mistake, not a run without feedback. */
function readFeedback(path) {
  if (path === undefined) return undefined;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`Cannot read the feedback file ${path}: ${error.code ?? error.message}`);
  }
  if (text.trim() === '') throw new UsageError(`The feedback file is empty: ${path}`);
  return text;
}

function plan(options, repo) {
  const feedback = readFeedback(options.feedback);
  if (options.files) {
    validateFiles(repo, options.files);
    return {
      needsAgent: true,
      analysis: null,
      feedback,
      sourceFiles: options.files,
      mergeBase: undefined,
      packages: PACKAGES.filter((name) => options.files.some((path) => path.startsWith(`${name}/`))),
      prompt: buildFilesPrompt({ files: options.files, feedback, root: TOOLS_ROOT }),
      repairPrompt: (text) => buildFilesPrompt({ files: options.files, feedback: text, repair: true, root: TOOLS_ROOT }),
    };
  }
  const analysis = analyzeChanges({ cwd: repo, base: options.base });
  return {
    needsAgent: analysis.decision.needs_agent,
    analysis,
    feedback,
    sourceFiles: analysis.source_files,
    mergeBase: analysis.merge_base,
    packages: PACKAGES.filter((name) => analysis.areas.includes(name)),
    prompt: buildDiffPrompt({ analysis, feedback, root: TOOLS_ROOT }),
    repairPrompt: (text) => buildDiffPrompt({ analysis, feedback: text, repair: true, root: TOOLS_ROOT }),
  };
}

/** Turns what the run produced into a result, or the reason there is none. */
export function interpretRun({ run, transcript }) {
  if (run.startError) return { failureReason: 'The agent could not start.', result: null };
  if (run.timedOut) return { failureReason: 'The agent timed out.', result: null };
  if (FAILURE_REASONS[transcript.outcome]) return { failureReason: FAILURE_REASONS[transcript.outcome], result: null };
  if (transcript.outcome !== 'success') return { failureReason: 'The run ended without a final result. This can be an API failure.', result: null };
  if (transcript.structuredOutput === null) return { failureReason: 'The agent returned no structured result.', result: null };
  const errors = validateResult(transcript.structuredOutput);
  if (errors.length > 0) return { failureReason: `The agent result failed validation with ${errors.length} problem(s).`, result: null };
  if (transcript.structuredOutput.decision === 'failed') {
    return { failureReason: `The agent reported that it could not finish: ${transcript.structuredOutput.reasoning}`, result: transcript.structuredOutput };
  }
  return { failureReason: null, result: transcript.structuredOutput };
}

/** Compares the agent's claims with the gate. The gate decides the outcome. */
export function decideOutcome({ result, verification }) {
  const mismatch = crossCheckWithVerification(result, verification);
  if (mismatch.length > 0) {
    verification.failures.push({ check: 'result-mismatch', message: `The result does not match the working tree: ${mismatch.join(' ')}` });
    verification.status = 'failed';
    return 'tests_rejected';
  }
  if (verification.status === 'failed') return 'tests_rejected';
  return verification.status === 'no_changes' ? 'no_tests_needed' : 'tests_added';
}

/** Remembers the accepted tests, because a later repair round can make them worse. */
function snapshotTests(repo, verification) {
  return new Map((verification.changed_files ?? []).map(({ path }) => [path, readFileSync(join(repo, path), 'utf8')]));
}

/** Puts the working tree back to the accepted tests. */
function restoreTests(repo, snapshot) {
  const changes = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).split('\0').filter(Boolean);
  for (const entry of changes) {
    const path = entry.slice(3);
    if (snapshot.has(path)) continue;
    if (entry.startsWith('??')) rmSync(join(repo, path), { force: true });
    else writeFileSync(join(repo, path), git(repo, ['show', `HEAD:${path}`]));
  }
  for (const [path, content] of snapshot) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

/** The first attempt keeps the plain names, and each repair round gets its own copy. */
const roundFile = (name, round) => (round === 0 ? name : name.replace(/\.(\w+)$/, `.round-${round}.$1`));

export function runPipeline(options, deps = {}) {
  const { repo } = options;
  const { baseline = runBaseline, verify = runVerify, mutate = runMutation, claude = runClaude, version = claudeVersion, log = (text) => process.stdout.write(`${text}\n`) } = deps;
  const definition = readAgentDefinition(TOOLS_ROOT);
  const artifacts = join(repo, ARTIFACTS_DIR);
  const steps = plan(options, repo);
  // Preloaded means placed in a prompt. A run with no agent has no prompt.
  const preloadedSkills = steps.needsAgent ? skillsForSourceFiles(steps.sourceFiles, TOOLS_ROOT) : [];
  const reportBase = {
    analysis: steps.analysis,
    head_sha: git(repo, ['rev-parse', 'HEAD']).trim(),
    prompt_version: definition.promptVersion,
    preloaded_skills: preloadedSkills,
  };

  if (options.dryRun) {
    const args = claudeArgs({ prompt: `<prompt: ${steps.prompt.length} characters>`, repo, maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, noBash: options.noBash });
    log(`Mode: ${options.files ? 'files' : `diff against ${options.base}`}`);
    if (steps.analysis) log(`Decision: ${steps.analysis.decision.reason_code}: ${steps.analysis.decision.reason}`);
    log(`Source files: ${steps.sourceFiles.join(', ') || 'none'}`);
    log(`Packages: ${steps.packages.join(', ') || 'none'}`);
    log(`Agent needed: ${steps.needsAgent}`);
    log(`Skills preloaded: ${preloadedSkills.join(', ') || 'none'}`);
    log(`Feedback: ${steps.feedback === undefined ? 'none' : `${steps.feedback.length} characters`}`);
    log(`Mutation check: ${options.noMutation ? 'off' : 'on'}. Repair rounds: ${options.repairRounds ?? 0}. Repair for mutants: ${options.mutationRepair ? 'on' : 'off'}.`);
    log(`Agent command: claude ${args.filter((arg) => !arg.startsWith('{')).join(' ')}`);
    log('Dry run: the agent and the tests did not run.');
    return { outcome: 'dry_run', exitCode: 0 };
  }

  const finish = (input, exitCode) => {
    const report = renderReport({ ...reportBase, ...input, usage: { ...reportBase.usage, ...input.usage } });
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, 'report-input.json'), JSON.stringify({ ...reportBase, ...input }, null, 2));
    writeFileSync(join(artifacts, 'report.md'), report.markdown);
    log(report.markdown);
    log(`Check result: ${report.conclusion}. Artifacts are in ${ARTIFACTS_DIR}/.`);
    return { outcome: input.outcome, conclusion: report.conclusion, exitCode };
  };

  if (!steps.needsAgent) return finish({ outcome: 'skipped' }, 0);

  const installed = version();
  if (!isSupportedVersion(installed)) {
    throw new UsageError(`Claude Code ${MINIMUM_CLAUDE_VERSION.join('.')} or later is required, found: ${installed?.trim() || 'none'}.`);
  }
  if (git(repo, ['status', '--porcelain']).trim() !== '') {
    throw new UsageError('The working tree has changes. Commit them first, so the gate can tell the agent\'s changes from yours.');
  }

  rmSync(artifacts, { recursive: true, force: true });
  mkdirSync(artifacts, { recursive: true });
  log(`Taking a baseline of ${steps.packages.join(', ')}...`);
  const baselineReport = baseline({ repo, packages: steps.packages });
  writeFileSync(join(artifacts, 'baseline.json'), JSON.stringify(baselineReport, null, 2));

  const maxRounds = options.repairRounds ?? 0;
  // A run with no transcript has no numbers, and the report must not show them as zero.
  const totals = { model: null, turns: null, cost_usd: null, blocked_calls: null };
  const addUp = (sum, value) => (Number.isFinite(value) ? (sum ?? 0) + value : sum);
  const invokedSkills = new Set();
  let feedback = steps.feedback;
  let round = 0;
  let mutationRounds = 0;
  let accepted = null;

  const reportInput = () => ({ usage: { ...totals }, invoked_skills: [...invokedSkills], repair_rounds: round });
  const finishAccepted = (note) => {
    restoreTests(repo, accepted.snapshot);
    return finish({ outcome: 'tests_added', result: accepted.result, verification: accepted.verification, mutation: accepted.mutation, repair_note: note, ...reportInput() }, 0);
  };

  for (;;) {
    const prompt = round === 0 ? steps.prompt : steps.repairPrompt(feedback);
    writeFileSync(join(artifacts, roundFile('prompt.txt', round)), prompt);
    if (feedback !== undefined) writeFileSync(join(artifacts, roundFile('feedback.txt', round)), feedback);

    log(round === 0 ? 'Running the agent...' : `Running the agent, repair round ${round}...`);
    const transcriptPath = join(artifacts, roundFile('transcript.jsonl', round));
    const run = claude({
      args: claudeArgs({ prompt, repo, maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, noBash: options.noBash }),
      repo,
      transcriptPath,
    });
    const transcript = readTranscript(existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : '');
    totals.model = transcript.model ?? totals.model;
    totals.turns = addUp(totals.turns, transcript.turns);
    totals.cost_usd = addUp(totals.cost_usd, transcript.costUsd);
    totals.blocked_calls = addUp(totals.blocked_calls, transcript.denials);
    for (const skill of transcript.skills) invokedSkills.add(skill);

    const { failureReason, result } = interpretRun({ run, transcript });
    if (result) writeFileSync(join(artifacts, roundFile('result.json', round)), JSON.stringify(result, null, 2));
    if (failureReason) {
      if (accepted) return finishAccepted(`A repair round failed, so the tests accepted earlier were kept. ${failureReason}`);
      return finish({ outcome: 'agent_failed', failure_reason: failureReason, result, ...reportInput() }, 1);
    }

    log('Running the gate...');
    const verification = verify({ repo, mergeBase: steps.mergeBase, sourceFiles: steps.sourceFiles, baseline: baselineReport });
    const outcome = decideOutcome({ result, verification });
    writeFileSync(join(artifacts, roundFile('verify.json', round)), JSON.stringify(verification, null, 2));

    let mutation;
    if (outcome === 'tests_added') {
      if (!options.noMutation) {
        log('Running the mutation check...');
        mutation = mutate({ repo, sourceFiles: steps.sourceFiles, mergeBase: steps.mergeBase });
        writeFileSync(join(artifacts, roundFile('mutation.json', round)), JSON.stringify(mutation, null, 2));
      }
      accepted = { result, verification, mutation, snapshot: snapshotTests(repo, verification) };
    }

    const repair = nextRepair({ outcome, mutation, round, maxRounds, mutationRounds, maxMutationRounds: options.mutationRepair ? MAX_MUTATION_ROUNDS : DEFAULT_MUTATION_ROUNDS });
    if (!repair) {
      if (outcome === 'tests_rejected' && accepted) return finishAccepted('The gate rejected a repair round, so the tests accepted earlier were kept.');
      return finish({ outcome, result, verification, mutation, ...reportInput() }, outcome === 'tests_rejected' ? 1 : 0);
    }
    feedback = repair === 'gate' ? gateFeedback(verification) : mutationFeedback(mutation);
    if (repair === 'mutation') mutationRounds += 1;
    round += 1;
  }
}

export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string' },
      files: { type: 'string' },
      feedback: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'no-bash': { type: 'boolean', default: false },
      'no-mutation': { type: 'boolean', default: false },
      'repair-rounds': { type: 'string', default: '0' },
      'mutation-repair': { type: 'boolean', default: false },
      'max-turns': { type: 'string', default: String(DEFAULT_MAX_TURNS) },
      'max-budget-usd': { type: 'string', default: String(DEFAULT_MAX_BUDGET_USD) },
    },
  });
  if (Boolean(values.base) === Boolean(values.files)) throw new UsageError('Pass either --base <ref> or --files <a,b>.');
  const maxTurns = Number(values['max-turns']);
  const maxBudgetUsd = Number(values['max-budget-usd']);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new UsageError('--max-turns must be a positive integer.');
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) throw new UsageError('--max-budget-usd must be a positive number.');
  const repairRounds = Number(values['repair-rounds']);
  if (!Number.isInteger(repairRounds) || repairRounds < 0 || repairRounds > MAX_REPAIR_ROUNDS) throw new UsageError(`--repair-rounds must be an integer from 0 to ${MAX_REPAIR_ROUNDS}.`);
  return {
    base: values.base,
    files: values.files ? values.files.split(',').map((path) => path.trim()).filter(Boolean) : undefined,
    feedback: values.feedback,
    dryRun: values['dry-run'],
    noBash: values['no-bash'],
    noMutation: values['no-mutation'],
    repairRounds,
    mutationRepair: values['mutation-repair'],
    maxTurns,
    maxBudgetUsd,
  };
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (root.status !== 0) throw new UsageError('This is not a git repository.');
  return runPipeline({ ...options, repo: realpathSync(root.stdout.trim()) }).exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`test-agent: ${error.message}\n`);
    process.exitCode = 2;
  }
}
