#!/usr/bin/env node
// Turns a git diff into JSON: what changed, what kind of file it is, where its
// test lives, and whether the agent is needed at all. Only reads git objects and
// never runs code from the branch, so it is safe on untrusted pull requests.
// File names come from the branch: treat every path in the output as data.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyTestPath } from '../../../lib/test-paths.mjs';

export const DEFAULT_LIMITS = { maxFiles: 50, maxLines: 2000 };

const GENERATED = [
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/,
  /^backend\/src\/generated\//,
  /^backend\/prisma\/migrations\//,
  /(?:^|\/)(?:dist|coverage|storybook-static)\//,
];
const DOCS = [
  /\.(?:md|mdx|rst|txt)$/i,
  /^docs\//,
  /(?:^|\/)LICENSE[^/]*$/,
  /\.stories\.[jt]sx?$/,
  /^backend\/openapi\.json$/,
];
const CONFIG = [
  /^\.github\//,
  /^\.claude\//,
  /^scripts\//,
  /(?:^|\/)\.storybook\//,
  /(?:^|\/)\.[^/]+$/,
  /(?:^|\/)package\.json$/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /(?:^|\/)[^/]*\.config\.[^/]+$/,
  /(?:^|\/)Dockerfile[^/]*$/,
  /(?:^|\/)compose\.ya?ml$/,
  /(?:^|\/)nginx\.conf$/,
  /^frontend\/index\.html$/,
  /^frontend\/src\/test\/setup\.ts$/,
  /^backend\/prisma\/schema\.prisma$/,
];
const ASSET = [/\.(?:css|svg|png|jpe?g|gif|ico|webp|woff2?|ttf)$/i];
// Matches the coverage exclusions in the package configs, apart from the design system.
const NO_LOGIC = [
  /(?:^|\/)types\.ts$/,
  /\.types\.ts$/,
  /\.d\.ts$/,
  /^frontend\/src\/(?:.+\/)?index\.ts$/,
  /^frontend\/src\/(?:.+\/)?constants\.tsx?$/,
  /\.constants\.ts$/,
  /^frontend\/src\/features\/todos\/api\/queryKeys\.ts$/,
  /^frontend\/src\/lib\/queryClient\.ts$/,
  /^frontend\/src\/main\.tsx$/,
  /^backend\/src\/main\.ts$/,
];
// The s flag matters: a newline in a file name must not take a file out of this class.
const SOURCE = [/^backend\/src\/.+\.ts$/s, /^frontend\/src\/.+\.tsx?$/s];

// Runtime code added to a file that is meant to hold none, so the path alone cannot excuse it.
const RUNTIME_CODE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class)\b|\b(?:if|switch|while|for)\s*\(/;

const UNUSUAL_NAME = /[\u0000-\u001f\u007f`$<>]/;

const REVIEWED_KINDS = ['source', 'no-logic', 'test', 'test-support'];

const STATUS_NAMES = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' };

const matchesAny = (patterns, path) => patterns.some((pattern) => pattern.test(path));

export function classifyKind(path) {
  const testClass = classifyTestPath(path);
  if (testClass === 'test') return 'test';
  if (testClass === 'shared-test-support') return 'test-support';
  if (matchesAny(GENERATED, path)) return 'generated';
  if (matchesAny(DOCS, path)) return 'docs';
  if (matchesAny(CONFIG, path)) return 'config';
  if (matchesAny(ASSET, path)) return 'asset';
  if (matchesAny(NO_LOGIC, path)) return 'no-logic';
  if (matchesAny(SOURCE, path)) return 'source';
  return 'other';
}

export function areaOf(path) {
  if (path.startsWith('backend/')) return 'backend';
  if (path.startsWith('frontend/')) return 'frontend';
  return null;
}

/** Where the test for a source file lives, following the conventions of each package. */
export function testCandidates(path) {
  const backend = /^backend\/src\/(?:(.+)\/)?([^/]+)\.ts$/s.exec(path);
  if (backend) {
    const [, dir, name] = backend;
    const candidates = [`backend/tests/${name}.test.ts`];
    if (dir) candidates.push(`backend/tests/${dir}/${name}.test.ts`);
    return candidates;
  }
  const frontend = /^(frontend\/src\/(?:.+\/)?[^/]+)\.(tsx?)$/s.exec(path);
  if (frontend) {
    const [, stem, extension] = frontend;
    const other = extension === 'ts' ? 'tsx' : 'ts';
    return [`${stem}.test.${extension}`, `${stem}.test.${other}`];
  }
  return [];
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', '--no-pager', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];

/** Parses `git diff --raw -z`. Renames and copies carry two paths. */
export function parseRaw(output) {
  const tokens = output.split('\0');
  const entries = [];
  for (let index = 0; index + 1 < tokens.length; ) {
    const header = tokens[index];
    if (!header.startsWith(':')) {
      index += 1;
      continue;
    }
    const [oldMode, newMode, , , statusField] = header.slice(1).split(' ');
    const letter = statusField[0];
    const hasTwoPaths = letter === 'R' || letter === 'C';
    const path = hasTwoPaths ? tokens[index + 2] : tokens[index + 1];
    entries.push({
      path,
      previous_path: hasTwoPaths ? tokens[index + 1] : undefined,
      status: STATUS_NAMES[letter] ?? 'modified',
      oldMode,
      newMode,
    });
    index += hasTwoPaths ? 3 : 2;
  }
  return entries;
}

/** Parses `git diff --numstat -z` into a map keyed by the new path. */
export function parseNumstat(output) {
  const tokens = output.split('\0');
  const counts = new Map();
  for (let index = 0; index < tokens.length; ) {
    const fields = tokens[index].split('\t');
    if (fields.length < 3) {
      index += 1;
      continue;
    }
    const [additions, deletions, inlinePath] = fields;
    const path = inlinePath === '' ? tokens[index + 2] : inlinePath;
    const binary = additions === '-' || deletions === '-';
    counts.set(path, {
      additions: binary ? 0 : Number(additions),
      deletions: binary ? 0 : Number(deletions),
      binary,
    });
    index += inlinePath === '' ? 3 : 1;
  }
  return counts;
}

function addsRuntimeCode(cwd, range, path) {
  const diff = git(cwd, ['diff', ...DIFF_FLAGS, '-U0', range, '--', path]);
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .some((line) => RUNTIME_CODE.test(line.slice(1)));
}

function decide(files, sourceFiles, limits) {
  if (files.length === 0) {
    return { needs_agent: false, reason_code: 'no_changes', reason: 'The diff is empty.' };
  }
  // The limit protects the cost of the agent, so it counts only what the agent would read.
  // A large change to configuration or documentation does not need the agent at all.
  const reviewed = files.filter((file) => REVIEWED_KINDS.includes(file.kind));
  const reviewedLines = reviewed.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (sourceFiles.length > 0 && (reviewed.length > limits.maxFiles || reviewedLines > limits.maxLines)) {
    return {
      needs_agent: false,
      reason_code: 'too_large',
      reason:
        `The change has ${reviewed.length} code and test files and ${reviewedLines} changed lines, over the limit of ` +
        `${limits.maxFiles} files or ${limits.maxLines} lines. Review test coverage by hand.`,
    };
  }
  if (sourceFiles.length > 0) {
    return {
      needs_agent: true,
      reason_code: 'source_changed',
      reason: `${sourceFiles.length} source file(s) changed. The agent decides whether tests are needed.`,
    };
  }
  const kinds = new Set(files.map((file) => file.kind));
  const only = (...allowed) => [...kinds].every((kind) => allowed.includes(kind));
  if (only('docs')) return { needs_agent: false, reason_code: 'docs_only', reason: 'Only documentation changed.' };
  if (only('test', 'test-support')) return { needs_agent: false, reason_code: 'tests_only', reason: 'Only tests changed.' };
  if (only('config')) return { needs_agent: false, reason_code: 'config_only', reason: 'Only configuration changed.' };
  if (only('generated')) return { needs_agent: false, reason_code: 'generated_only', reason: 'Only generated files changed.' };
  if (only('no-logic')) return { needs_agent: false, reason_code: 'types_only', reason: 'Only types and other files without logic changed.' };
  return {
    needs_agent: false,
    reason_code: 'no_testable_changes',
    reason: 'No source file has a change that a unit test could check.',
  };
}

export function analyzeChanges({ cwd, base, head = 'HEAD', limits = DEFAULT_LIMITS }) {
  for (const ref of [base, head]) {
    if (typeof ref !== 'string' || ref === '' || ref.startsWith('-')) {
      throw new Error(`Invalid git ref: ${JSON.stringify(ref)}`);
    }
  }
  const headSha = git(cwd, ['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`]).trim();
  const baseSha = git(cwd, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim();
  const mergeBase = git(cwd, ['merge-base', baseSha, headSha]).trim();
  const range = `${mergeBase}..${headSha}`;

  const raw = parseRaw(git(cwd, ['diff', ...DIFF_FLAGS, '--raw', '-z', '--no-abbrev', '-M', range]));
  const counts = parseNumstat(git(cwd, ['diff', ...DIFF_FLAGS, '--numstat', '-z', '-M', range]));
  const ignoringWhitespace = parseNumstat(git(cwd, ['diff', ...DIFF_FLAGS, '--numstat', '-z', '-M', '-w', range]));
  const tree = new Set(git(cwd, ['ls-tree', '-r', '--name-only', '-z', headSha]).split('\0'));

  const files = raw.map((entry) => {
    const { additions = 0, deletions = 0, binary = false } = counts.get(entry.path) ?? {};
    const whitespace = ignoringWhitespace.get(entry.path);
    const whitespaceOnly =
      !binary && additions + deletions > 0 && (whitespace?.additions ?? 0) + (whitespace?.deletions ?? 0) === 0;
    let kind = classifyKind(entry.path);
    if (kind === 'no-logic' && entry.status !== 'deleted' && addsRuntimeCode(cwd, range, entry.path)) kind = 'source';
    const candidates = kind === 'source' ? testCandidates(entry.path) : [];
    return {
      path: entry.path,
      ...(entry.previous_path ? { previous_path: entry.previous_path } : {}),
      status: entry.status,
      area: areaOf(entry.path),
      kind,
      additions,
      deletions,
      binary,
      whitespace_only: whitespaceOnly,
      symlink: entry.newMode === '120000' || entry.oldMode === '120000',
      test_candidates: candidates,
      existing_test: candidates.find((candidate) => tree.has(candidate)) ?? null,
    };
  });

  const sourceFiles = files
    .filter(
      (file) =>
        file.kind === 'source' &&
        file.status !== 'deleted' &&
        !file.whitespace_only &&
        !file.binary &&
        file.additions + file.deletions > 0,
    )
    .map((file) => file.path);

  return {
    schema_version: 1,
    base: baseSha,
    head: headSha,
    merge_base: mergeBase,
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
    areas: [...new Set(files.map((file) => file.area).filter(Boolean))].sort(),
    decision: decide(files, sourceFiles, limits),
    source_files: sourceFiles,
    shared_test_support: files.filter((file) => file.kind === 'test-support').map((file) => file.path),
    flags: {
      symlinks: files.filter((file) => file.symlink).map((file) => file.path),
      unusual_names: files.filter((file) => UNUSUAL_NAME.test(file.path)).map((file) => file.path),
    },
    files,
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      head: { type: 'string', default: 'HEAD' },
      'max-files': { type: 'string', default: String(DEFAULT_LIMITS.maxFiles) },
      'max-lines': { type: 'string', default: String(DEFAULT_LIMITS.maxLines) },
    },
  });
  if (!values.base) throw new Error('Usage: analyze-changes.mjs --base <ref> [--head <ref>] [--max-files N] [--max-lines N]');
  const limits = { maxFiles: Number(values['max-files']), maxLines: Number(values['max-lines']) };
  if (!Number.isInteger(limits.maxFiles) || !Number.isInteger(limits.maxLines)) {
    throw new Error('--max-files and --max-lines must be integers.');
  }
  const analysis = analyzeChanges({ cwd: process.cwd(), base: values.base, head: values.head, limits });
  process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`analyze-changes: ${error.message}\n`);
    process.exit(2);
  }
}
