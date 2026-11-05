// Moves the agent's tests between jobs as a patch, and decides what may be applied. A patch
// comes from a model, or from a job that ran code from the branch, so it is not trusted. The
// check looks at what git has in the index after applying it, and not at the text of the patch,
// because text can be written so that a parser and git read it differently.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { classifyTestPath } from '../../../.claude/lib/test-paths.mjs';
import { isInstructionFile } from './instruction-files.mjs';

const REGULAR_FILE = '100644';
// Claude Code Action restores these from the base branch, which can show as changes.
const RESTORED_BY_THE_ACTION = [/^\.claude(?:\/|$)/, /^\.claude-pr(?:\/|$)/, /^\.mcp\.json$/, /^\.claude\.json$/, /^\.gitmodules$/, /^\.ripgreprc$/, /^CLAUDE(?:\.local)?\.md$/, /^\.husky(?:\/|$)/];

export function git(repo, args, { input, allowFailure = false } = {}) {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', '--no-pager', ...args], { cwd: repo, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args[0]} failed: ${result.stderr.trim().slice(0, 500)}`);
  return result;
}

/** Parses `git diff --raw -z --no-renames`. */
export function parseRawDiff(output) {
  const tokens = output.split('\0');
  const entries = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const [oldMode, newMode, , , status] = tokens[index].slice(1).split(' ');
    entries.push({ path: tokens[index + 1], oldMode, newMode, status });
  }
  return entries;
}

/** The rule for one change in the index. @returns {string | null} Why it is refused. */
export function refusalFor({ path, newMode, status }) {
  if (classifyTestPath(path) === null) return 'is outside the test allowlist';
  if (status !== 'A' && status !== 'M') return 'is not a plain addition or change';
  if (newMode !== REGULAR_FILE) return `has mode ${newMode}, and only a regular file may be committed`;
  return null;
}

/** What differs between HEAD and the index, with the reason for each change that is refused. */
export function inspectIndex(repo) {
  const output = git(repo, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', 'HEAD']).stdout;
  const entries = parseRawDiff(output);
  const problems = [];
  for (const entry of entries) {
    const reason = refusalFor(entry);
    if (reason) problems.push({ path: entry.path, reason });
  }
  return { paths: entries.map(({ path }) => path), problems };
}

/**
 * Applies a patch to the index and the working tree. If anything is refused, both go back to
 * HEAD, so nothing from the patch is left to run or to commit.
 * @returns {{ applied: boolean, paths: string[], problems: { path: string, reason: string }[] }}
 */
export function applyPatch(repo, patchFile) {
  const result = git(repo, ['apply', '--index', '--whitespace=nowarn', '--', patchFile], { allowFailure: true });
  if (result.status !== 0) {
    git(repo, ['reset', '--hard', '-q', 'HEAD']);
    return { applied: false, paths: [], problems: [{ path: '(the patch)', reason: 'does not apply' }] };
  }
  const { paths, problems } = inspectIndex(repo);
  if (problems.length > 0) {
    // New files came through the index, so this removes them too.
    git(repo, ['reset', '--hard', '-q', 'HEAD']);
    return { applied: false, paths: [], problems };
  }
  return { applied: true, paths, problems: [] };
}

function statusEntries(repo) {
  const output = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).stdout;
  return output.split('\0').filter(Boolean).map((entry) => ({ status: entry.slice(0, 2).trim(), path: entry.slice(3) }));
}

/**
 * Stages what the agent may have changed and writes it as a patch. A change anywhere else is
 * reported and left out, so the gate can refuse the attempt without ever running it. Only a deleted
 * instruction file is the work of remove-instruction-files. One that was written counts as outside.
 * @returns {{ paths: string[], outside: string[], removedInstructionFiles: string[] }}
 */
export function collectPatch(repo, patchFile) {
  const allowed = [];
  const outside = [];
  const removedInstructionFiles = [];
  for (const { status, path } of statusEntries(repo)) {
    if (classifyTestPath(path) !== null) allowed.push(path);
    else if (status === 'D' && isInstructionFile(path)) removedInstructionFiles.push(path);
    else if (!RESTORED_BY_THE_ACTION.some((pattern) => pattern.test(path))) outside.push(path);
  }
  if (allowed.length > 0) git(repo, ['add', '-A', '--', ...allowed]);
  const patch = git(repo, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index', 'HEAD', '--', ...(allowed.length > 0 ? allowed : ['.'])]).stdout;
  writeFileSync(patchFile, allowed.length > 0 ? patch : '');
  return { paths: allowed, outside, removedInstructionFiles };
}
