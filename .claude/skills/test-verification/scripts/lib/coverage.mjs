import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const METRICS = ['lines', 'branches', 'functions', 'statements'];

const toPosix = (path) => path.split(sep).join('/');

/** Parses lcov into a map of file path to a map of line number to hit count. */
export function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      current = new Map();
      files.set(line.slice(3).trim(), current);
    } else if (line.startsWith('DA:') && current) {
      const [lineNumber, hits] = line.slice(3).split(',');
      current.set(Number(lineNumber), Number(hits));
    } else if (line.startsWith('end_of_record')) {
      current = null;
    }
  }
  return files;
}

/** Returns the line numbers in the new version of a file that a `git diff -U0` adds or changes. */
export function changedLinesFromDiff(diff) {
  const lines = [];
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let offset = 0; offset < count; offset += 1) lines.push(start + offset);
  }
  return lines;
}

/** Only lines the coverage tool instruments count. Comments and types have no entry. */
export function changedLineCoverage(changedLines, hits) {
  const instrumented = changedLines.filter((line) => hits?.has(line));
  const uncovered = instrumented.filter((line) => hits.get(line) === 0);
  return {
    total: instrumented.length,
    covered: instrumented.length - uncovered.length,
    uncovered,
  };
}

function pickMetrics(entry) {
  return Object.fromEntries(
    METRICS.map((metric) => [metric, { pct: entry[metric].pct, covered: entry[metric].covered, total: entry[metric].total }]),
  );
}

export function coverageFiles(repo, packageName) {
  const directory = join(repo, packageName, 'coverage');
  return { summary: join(directory, 'coverage-summary.json'), lcov: join(directory, 'lcov.info') };
}

/** Old reports must not be read as the result of a run that crashed. */
export function clearCoverage(repo, packageName) {
  for (const path of Object.values(coverageFiles(repo, packageName))) rmSync(path, { force: true });
}

/** Reads the reports of one package, with every path made relative to the repository. */
export function readCoverage(repo, packageName) {
  const paths = coverageFiles(repo, packageName);
  if (!existsSync(paths.summary) || !existsSync(paths.lcov)) return null;
  const summary = JSON.parse(readFileSync(paths.summary, 'utf8'));
  const files = {};
  for (const [path, entry] of Object.entries(summary)) {
    if (path !== 'total') files[toPosix(relative(repo, path))] = pickMetrics(entry);
  }
  const hits = new Map();
  for (const [path, lines] of parseLcov(readFileSync(paths.lcov, 'utf8'))) {
    hits.set(toPosix(isAbsolute(path) ? relative(repo, path) : join(packageName, path)), lines);
  }
  return { total: pickMetrics(summary.total), files, hits };
}

function metricsForFile(coverage, path) {
  return coverage?.files?.[path] ?? null;
}

/** Compares totals and the given source files before and after the agent's tests. */
export function compareCoverage({ before, after, sourceFiles, changedLines }) {
  return {
    total: { before: before?.total ?? null, after: after?.total ?? null },
    files: sourceFiles.map((path) => ({
      path,
      before: metricsForFile(before, path),
      after: metricsForFile(after, path),
      changed_lines: changedLines?.has(path) ? changedLineCoverage(changedLines.get(path), after?.hits?.get(path)) : null,
    })),
  };
}

/** Removes what a baseline file does not need and cannot serialize. */
export function serializableCoverage(coverage) {
  return coverage === null ? null : { total: coverage.total, files: coverage.files };
}
