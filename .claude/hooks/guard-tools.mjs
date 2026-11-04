#!/usr/bin/env node
// PreToolUse hook. Exit 2 blocks the tool call and shows stderr to the model.
// Exit 0 with no output is not an approval: permission rules still apply.
//
// Every session: git and gh are limited to read-only use.
// The unit test agent: everything not listed here is denied.
//
// The Bash checks read command text, so they are a heuristic and not a security
// boundary. In CI the agent runs without Bash, which is the real boundary there.
// settings.json sets onFailure: "block" so a hook that cannot start also blocks.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTestPath } from '../lib/test-paths.mjs';

const AGENT_NAME = 'unit-test-agent';
const ENFORCE_ENV = 'UNIT_TEST_AGENT_ENFORCE';

// Derived from this file and not from the environment, so that the boundary
// does not depend on a value the session could influence.
const REPO_ROOT = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));

const AGENT_SKILLS = new Set([
  'pr-change-analysis',
  'backend-unit-tests',
  'frontend-unit-tests',
  'test-verification',
  'pr-report',
]);

// Readable by no one in agent mode, even inside the repository.
const UNREADABLE_SEGMENT = /^(?:\.git|\.claude-pr|\.env(?:\..*)?|\.npmrc|\.test-agent)$/;

const GIT_READ_ONLY = new Set([
  'blame',
  'cat-file',
  'check-ignore',
  'describe',
  'diff',
  'grep',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
  'version',
]);

const GIT_GLOBAL_FLAGS = new Set(['--no-pager', '-P', '-p', '--paginate', '--no-optional-locks']);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(['-C', '--git-dir', '--work-tree']);

const GIT_BRANCH_WRITE_FLAG =
  /^(?:-[dDmMcCfu]|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description)$/;

// Options of read-only commands that write a file or run a program.
const GIT_UNSAFE_READ_OPTION =
  /^(?:--(?:output|ext-diff|no-index|open-files-in-pager|upload-pack|exec)(?:=|$)|-O)/;

const GH_READ_ONLY = new Set([
  'auth status',
  'issue list',
  'issue view',
  'label list',
  'pr checks',
  'pr diff',
  'pr list',
  'pr status',
  'pr view',
  'release list',
  'release view',
  'repo view',
  'run download',
  'run list',
  'run view',
  'run watch',
  'secret list',
  'workflow list',
  'workflow view',
]);

const GH_API_WRITE_FLAG = /^(?:-f|-F|--field(?:=.*)?|--raw-field(?:=.*)?|--input(?:=.*)?)$/;

const BASH_HINT =
  'Allowed: npm --prefix <backend|frontend> run <test|test:coverage> [-- <test file> | --coverage | ' +
  '--coverage.include=<path> | --reporter=<dot|verbose|json>], ' +
  'npm --prefix <backend|frontend> run typecheck, npm --prefix frontend run format:check.';

class Denied extends Error {}

function deny(reason) {
  throw new Denied(reason);
}

function quoted(value) {
  return JSON.stringify(String(value).slice(0, 200));
}

/** Resolves symlinks in the part of the path that exists. A dangling link throws. */
function resolveExistingPrefix(absolutePath) {
  const missing = [];
  let current = absolutePath;
  while (true) {
    try {
      lstatSync(current);
      return join(realpathSync(current), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      // A link that exists but points nowhere reports ENOENT from realpath. It must
      // not be treated as a missing path, because a write would follow the link.
      if (isDanglingLink(current) || parent === current) deny(`Cannot resolve path ${quoted(absolutePath)}.`);
      missing.push(basename(current));
      current = parent;
    }
  }
}

function isDanglingLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function toRepoRelative(absolutePath) {
  const path = relative(REPO_ROOT, absolutePath);
  if (path === '') return '.';
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
  return path.split(sep).join('/');
}

/**
 * Returns the repository-relative path as written and the one it resolves to.
 * Both are checked, so a link inside the repository cannot reach a denied file.
 */
function repoPaths(rawPath, cwd) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') deny('The tool call has no valid path.');
  if (rawPath.includes('\0')) deny('The path contains a NUL byte.');
  // Tools may expand these on their own, so the text cannot be taken as a literal path.
  if (rawPath.startsWith('~') || rawPath.includes('$')) {
    deny(`Path ${quoted(rawPath)} uses shell expansion, which is not allowed.`);
  }
  const base = typeof cwd === 'string' && isAbsolute(cwd) ? cwd : REPO_ROOT;
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath);
  const lexical = toRepoRelative(absolute);
  const real = toRepoRelative(resolveExistingPrefix(absolute));
  if (lexical === null || real === null) deny(`Path ${quoted(rawPath)} is outside the repository.`);
  return { lexical, real };
}

function checkReadable(rawPath, cwd) {
  const { lexical, real } = repoPaths(rawPath, cwd);
  for (const path of [lexical, real]) {
    if (path.split('/').some((segment) => UNREADABLE_SEGMENT.test(segment))) {
      deny(`Reading ${quoted(rawPath)} is not allowed.`);
    }
  }
}

function checkWritable(rawPath, cwd) {
  const { lexical, real } = repoPaths(rawPath, cwd);
  if (classifyTestPath(lexical) === null || classifyTestPath(real) === null) {
    deny(
      `Writing ${quoted(rawPath)} is not allowed. The agent may change only test files and shared ` +
        'test support. If application code looks wrong, report it instead of changing it.',
    );
  }
}

function checkGlobPattern(pattern) {
  if (typeof pattern !== 'string' || pattern === '') deny('The search has no valid pattern.');
  if (
    isAbsolute(pattern) ||
    pattern.startsWith('~') ||
    pattern.includes('$') ||
    pattern.split(/[\\/]/).includes('..')
  ) {
    deny(`Pattern ${quoted(pattern)} reaches outside the repository.`);
  }
}

function checkAgentBash(command) {
  if (typeof command !== 'string') deny('The Bash call has no command.');
  const match = /^npm --prefix (backend|frontend) run (test|test:coverage|typecheck|format:check)(?: -- (.+))?$/.exec(
    command,
  );
  if (!match) deny(`Command ${quoted(command)} is not allowed. ${BASH_HINT}`);
  const [, workspace, script, args] = match;
  if (script === 'format:check' && workspace !== 'frontend') deny(`The backend has no formatter. ${BASH_HINT}`);
  if (args === undefined) return;
  if (script !== 'test' && script !== 'test:coverage') deny(`Script ${script} takes no arguments. ${BASH_HINT}`);
  for (const arg of args.split(' ')) {
    const safeFlag =
      arg === '--coverage' ||
      /^--reporter=(?:dot|verbose|json)$/.test(arg) ||
      /^--coverage\.include=[\w@][\w./@-]*$/.test(arg);
    // A positional argument is only a filter on test file names, so it runs no code.
    const safeFilter = /^[\w@][\w./@-]*$/.test(arg) && !arg.split('/').includes('..');
    if (!safeFlag && !safeFilter) deny(`Argument ${quoted(arg)} is not allowed. ${BASH_HINT}`);
  }
}

function checkAgentTool(input) {
  const { tool_name: tool, tool_input: toolInput = {}, cwd } = input;
  switch (tool) {
    case 'Read':
      checkReadable(toolInput.file_path, cwd);
      return;
    case 'Grep':
      if (toolInput.path !== undefined) checkReadable(toolInput.path, cwd);
      if (toolInput.glob !== undefined) checkGlobPattern(toolInput.glob);
      return;
    case 'Glob':
      if (toolInput.path !== undefined) checkReadable(toolInput.path, cwd);
      checkGlobPattern(toolInput.pattern);
      return;
    case 'Edit':
    case 'Write':
      checkWritable(toolInput.file_path, cwd);
      return;
    case 'Bash':
      checkAgentBash(toolInput.command);
      return;
    case 'Skill':
      if (!AGENT_SKILLS.has(toolInput.skill)) deny(`Skill ${quoted(toolInput.skill)} is not available to this agent.`);
      return;
    // Claude Code uses this tool to return output for --json-schema.
    case 'StructuredOutput':
      return;
    default:
      deny(`Tool ${quoted(tool)} is not available to this agent.`);
  }
}

function checkGit(args) {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (GIT_GLOBAL_FLAGS.has(arg)) {
      index += 1;
    } else if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 2;
    } else if ([...GIT_GLOBAL_OPTIONS_WITH_VALUE].some((option) => arg.startsWith(`${option}=`))) {
      index += 1;
    } else {
      break;
    }
  }
  const subcommand = args[index];
  if (subcommand === undefined) return;
  const rest = args.slice(index + 1);
  if (subcommand === 'branch') {
    if (rest.every((arg) => arg.startsWith('-') && !GIT_BRANCH_WRITE_FLAG.test(arg))) return;
  } else if (subcommand === 'remote') {
    if (rest.length === 0 || ['-v', '--verbose', 'get-url', 'show'].includes(rest[0])) return;
  } else if (subcommand === 'config') {
    if (['--get', '--get-all', '--list', '-l'].includes(rest[0])) return;
  } else if (GIT_READ_ONLY.has(subcommand)) {
    if (!rest.some((arg) => GIT_UNSAFE_READ_OPTION.test(arg))) return;
  }
  deny(
    `git ${subcommand} is not allowed here: only read-only git commands may run. ` +
      'The person who owns this repository commits and pushes. If this is a text search and not ' +
      'a git command, use the Grep tool.',
  );
}

function checkGh(args) {
  const noun = args[0];
  if (noun === undefined || noun === '--version' || noun === '--help') return;
  if (noun === 'api') {
    const method = args.findIndex((arg) => arg === '-X' || arg === '--method');
    const inlineMethod = args.find((arg) => /^(?:-X|--method=).+/.test(arg));
    const value = method >= 0 ? args[method + 1] : inlineMethod?.replace(/^(?:-X|--method=)/, '');
    const isGet = value === undefined || value.toUpperCase() === 'GET';
    if (isGet && !args.some((arg) => GH_API_WRITE_FLAG.test(arg))) return;
  } else if (GH_READ_ONLY.has(`${noun} ${args[1]}`)) {
    return;
  }
  deny(`${quoted(['gh', noun, args[1]].filter(Boolean).join(' '))} is not allowed here: only read-only gh commands may run.`);
}

/** Checks every git and gh invocation found in the text, including nested ones. */
function checkVersionControl(command) {
  if (typeof command !== 'string') deny('The Bash call has no command.');
  // `git $(echo push)` and `git $X` hide the subcommand from the checks below.
  if (/(?:^|[\s/;&|(])(?:git|gh)\s+["']*[$`]/.test(command)) {
    deny('A git or gh subcommand built from a shell expansion is not allowed.');
  }
  // Quotes are removed so that `git 'push'` and `sh -c "git push"` are seen as plain text.
  const text = command.replace(/\\\r?\n/g, ' ').replace(/['"\\]/g, '');
  for (const segment of text.split(/\$\(|&&|\|\||[;&|\n\r`()]/)) {
    const tokens = segment.trim().split(/\s+/);
    tokens.forEach((token, index) => {
      const name = basename(token);
      if (name === 'git') checkGit(tokens.slice(index + 1));
      if (name === 'gh') checkGh(tokens.slice(index + 1));
    });
  }
}

function check(input) {
  if (input === null || typeof input !== 'object' || typeof input.tool_name !== 'string') {
    deny('The hook input is not valid.');
  }
  const strict = input.agent_type === AGENT_NAME || process.env[ENFORCE_ENV] === '1';
  if (strict) {
    checkAgentTool(input);
  } else if (input.tool_name === 'Bash') {
    checkVersionControl(input.tool_input?.command);
  }
}

try {
  check(JSON.parse(readFileSync(0, 'utf8')));
} catch (error) {
  // Anything unexpected blocks the call: a guard that crashes must not let tools through.
  const reason = error instanceof Denied ? error.message : `guard-tools failed: ${error.message}`;
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}
