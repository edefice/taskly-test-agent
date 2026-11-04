// Rules for the workflow files, which a test applies to the real files. What protects the API
// key is written in YAML, so a later edit could undo it without any test noticing. actionlint
// checks that a workflow is valid. This checks that it is safe.
//
// It reads the fixed layout of these files by indentation, with no YAML library, because the
// tools here have no dependencies. A file in another layout is an error and not a pass.

const SECRET_NAME = 'ANTHROPIC_API_KEY';
export const AGENT_ACTION = 'anthropics/claude-code-action';
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const UNTRUSTED_IN_SCRIPT = /\$\{\{[^}]*(?:github\.event|github\.head_ref|inputs\.)[^}]*\}\}/;
// The only commands the job with the key may run. Each one is for tools from the base commit.
const AGENT_JOB_COMMANDS = [/^node "\$TOOLS\/scripts\/ci\/[\w-]+\.mjs"/, /^mv agent-tools "\$RUNNER_TEMP\/tools"$/, /^echo "TOOLS=\$RUNNER_TEMP\/tools" >> "\$GITHUB_ENV"$/, /^for i in 1 2 3; do sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends bubblewrap socat && break; echo "apt-get attempt \$i failed, retrying\.\.\."; sleep 5; done$/, /^if \[ -f \/proc\/sys\/kernel\/apparmor_restrict_unprivileged_userns \]; then sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0; fi$/];
const INDENT = /^( *)/;

const indentOf = (line) => INDENT.exec(line)[1].length;
const isContent = (line) => line.trim() !== '' && !line.trim().startsWith('#');

/** Splits lines into blocks that start at the given indent, by what a test on the start says. */
function blocks(lines, indent, startsBlock) {
  const found = [];
  let current = null;
  for (const line of lines) {
    if (isContent(line) && indentOf(line) === indent && startsBlock(line)) {
      current = [line];
      found.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  return found;
}

const fieldOf = (lines, indent, name) => {
  const line = lines.find((text) => indentOf(text) === indent && text.trim().startsWith(`${name}:`));
  return line === undefined ? undefined : line.trim().slice(name.length + 1).trim();
};

// A pinned action carries its version as a comment, which is not part of the value.
const stripQuotes = (value) => value?.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '');

function parseStep(lines) {
  const first = lines[0].replace('- ', '  ');
  const normalized = [first, ...lines.slice(1)];
  const field = (name) => stripQuotes(fieldOf(normalized, 8, name));
  const runIndex = normalized.findIndex((line) => indentOf(line) === 8 && line.trim().startsWith('run:'));
  let run = null;
  if (runIndex !== -1) {
    const inline = normalized[runIndex].trim().slice(4).trim();
    run = inline === '|' || inline === '>' ? normalized.slice(runIndex + 1).filter((line) => indentOf(line) > 8 && isContent(line)).map((line) => line.trim()) : [inline];
  }
  return { lines: normalized, text: normalized.join('\n'), id: field('id'), name: field('name'), uses: field('uses'), run, workingDirectory: field('working-directory') };
}

/** @returns {{ header: string[], jobs: { name: string, lines: string[], uses?: string, steps: object[] }[] }} */
export function parseWorkflow(text) {
  const lines = text.split('\n');
  const jobsAt = lines.indexOf('jobs:');
  if (jobsAt === -1) throw new Error('It has no top-level jobs key.');
  const jobs = blocks(lines.slice(jobsAt + 1), 2, (line) => /^ {2}[\w-]+:\s*$/.test(line)).map((jobLines) => {
    const stepsAt = jobLines.findIndex((line) => indentOf(line) === 4 && line.trim() === 'steps:');
    const steps = stepsAt === -1 ? [] : blocks(jobLines.slice(stepsAt + 1), 6, (line) => line.trim().startsWith('- ')).map(parseStep);
    return { name: jobLines[0].trim().slice(0, -1), lines: jobLines, jobText: jobLines.join('\n'), head: stepsAt === -1 ? jobLines : jobLines.slice(0, stepsAt), uses: stripQuotes(fieldOf(jobLines, 4, 'uses')), steps };
  });
  if (jobs.length === 0) throw new Error('No job is in the expected layout.');
  return { header: lines.slice(0, jobsAt), jobs };
}

/** Rules for every workflow. @returns {string[]} */
export function checkWorkflow(text, file = 'workflow') {
  let workflow;
  try {
    workflow = parseWorkflow(text);
  } catch (error) {
    return [`${file}: ${error.message}`];
  }
  const errors = [];
  const report = (message) => errors.push(`${file}: ${message}`);
  const header = workflow.header.filter(isContent).join('\n');
  if (/pull_request_target|workflow_run/.test(text)) report('It uses a trigger that runs with secrets on code from a pull request.');
  if (!/^permissions:/m.test(header)) report('It has no top-level permissions.');
  if (/write-all/.test(text)) report('It uses write-all.');
  if (/secrets:\s*inherit/.test(text)) report('It passes all secrets with inherit.');
  if (/secrets\./.test(header)) report('It uses a secret at the top level, where every job gets it.');
  for (const job of workflow.jobs) {
    if (!job.uses && fieldOf(job.head, 4, 'timeout-minutes') === undefined) report(`Job ${job.name} has no timeout-minutes.`);
    if (!job.uses && /secrets\./.test(job.head.join('\n'))) report(`Job ${job.name} uses a secret at the job level, where every step gets it.`);
    const writes = /contents:\s*write/.test(job.head.join('\n'));
    for (const step of job.steps) {
      const where = `Job ${job.name}, step ${step.name ?? step.id ?? step.uses ?? 'without a name'}`;
      if (step.uses && !step.uses.startsWith('./') && !PINNED.test(step.uses)) report(`${where}: the action is not pinned to a full commit SHA.`);
      if (step.uses?.startsWith('actions/checkout@') && !writes && !/persist-credentials:\s*false/.test(step.text)) report(`${where}: a checkout keeps its credentials.`);
      if (step.run?.some((line) => UNTRUSTED_IN_SCRIPT.test(line))) report(`${where}: a script expands text from the event. Pass it through env.`);
    }
  }
  return errors;
}

/**
 * The rules that keep the key where it belongs. It may appear in the job of one workflow, in two
 * steps, and in the workflow that calls it, as one passed value. The action gets it as an input
 * and not as env, because every step inside the action sees the env of the step that uses it,
 * also the one that installs its packages. The scan gets it as env.
 * @param {Record<string, string>} files File name to content, for all workflows.
 * @returns {string[]}
 */
export function checkSecretIsolation(files, roundFile = 'test-agent-round.yml') {
  const errors = [];
  if (!files[roundFile]) return [`${roundFile} is missing.`];
  const reference = /secrets\.(\w+)/g;
  for (const [file, text] of Object.entries(files)) {
    for (const [, name] of text.matchAll(reference)) {
      if (name !== SECRET_NAME && name !== 'GITHUB_TOKEN') errors.push(`${file}: it uses the secret ${name}, which nothing here expects.`);
    }
    if (file === roundFile) continue;
    const workflow = parseWorkflow(text);
    for (const job of workflow.jobs) {
      if (!/secrets\./.test(job.jobText)) continue;
      if (job.uses !== `./.github/workflows/${roundFile}`) errors.push(`${file}: job ${job.name} uses a secret and is not the call of ${roundFile}.`);
      if (job.steps.length > 0) errors.push(`${file}: job ${job.name} uses a secret and has steps.`);
    }
  }

  const round = parseWorkflow(files[roundFile]);
  const agentJobs = round.jobs.filter((job) => /secrets\./.test(job.jobText));
  if (agentJobs.length !== 1) return [...errors, `${roundFile}: ${agentJobs.length} jobs use the key, and exactly one must.`];
  const [agent] = agentJobs;

  for (const line of agent.head) {
    if (/id-token:|contents:\s*write|pull-requests:\s*write|checks:\s*write|actions:\s*write/.test(line)) errors.push(`${roundFile}: job ${agent.name} has more than read access: ${line.trim()}`);
  }

  const holders = agent.steps.filter((step) => /secrets\./.test(step.text));
  const action = holders.find((step) => step.uses?.startsWith(`${AGENT_ACTION}@`));
  const scan = holders.find((step) => step.run?.some((line) => line.includes('scan-secret.mjs')));
  if (holders.length !== 2 || !action || !scan) errors.push(`${roundFile}: the key must be in exactly two steps, the action and the scan, and it is in ${holders.length}.`);
  const onlyLine = (step, pattern) => {
    const uses = step.lines.filter((line) => /secrets\./.test(line));
    return uses.length === 1 && pattern.test(uses[0]);
  };
  if (action && !onlyLine(action, new RegExp(`^ {10}anthropic_api_key: \\$\\{\\{ secrets\\.${SECRET_NAME} \\}\\}$`))) {
    errors.push(`${roundFile}: the action must get the key as the input anthropic_api_key, and in no other way, because the steps inside it see its env.`);
  }
  // The step for inline comments is the only other step inside the action that reads the input.
  if (action && !/classify_inline_comments: 'false'/.test(action.text)) errors.push(`${roundFile}: the action must have classify_inline_comments off, because that step would get the key.`);
  if (scan && !onlyLine(scan, new RegExp(`^ {10}${SECRET_NAME}: \\$\\{\\{ secrets\\.${SECRET_NAME} \\}\\}$`))) {
    errors.push(`${roundFile}: the scan must get the key as one env entry, and in no other way.`);
  }
  if (scan) {
    if (!/^node "\$TOOLS\/scripts\/ci\/scan-secret\.mjs"/.test(scan.run[0] ?? '') || scan.run.length !== 1) errors.push(`${roundFile}: the scan must only run the script from the base commit.`);
    if (scan.workingDirectory !== '${{ runner.temp }}') errors.push(`${roundFile}: the scan must run outside the checkout of the pull request.`);
  }

  // No code from the pull request may run in the job that holds the key.
  for (const step of agent.steps) {
    for (const line of step.run ?? []) {
      if (!AGENT_JOB_COMMANDS.some((allowed) => allowed.test(line))) errors.push(`${roundFile}: job ${agent.name} runs a command it may not: ${line}`);
    }
    if (step.uses && /actions\/setup-node@/.test(step.uses) && /cache:/.test(step.text)) errors.push(`${roundFile}: job ${agent.name} restores a cache, which code from a pull request can have written.`);
  }

  const order = (step) => agent.steps.indexOf(step);
  const uploads = agent.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
  if (uploads.length === 0) errors.push(`${roundFile}: job ${agent.name} uploads nothing, so the rule below cannot hold.`);
  for (const upload of uploads) {
    if (scan && order(upload) < order(scan)) errors.push(`${roundFile}: an upload runs before the scan.`);
    if (scan && !new RegExp(`steps\\.${scan.id}\\.outcome == 'success'`).test(upload.text)) errors.push(`${roundFile}: an upload does not depend on a clean scan.`);
    if (/secrets\./.test(upload.text)) errors.push(`${roundFile}: an upload holds the key.`);
  }
  if (scan && action && order(scan) < order(action)) errors.push(`${roundFile}: the scan runs before the action.`);
  return errors;
}
