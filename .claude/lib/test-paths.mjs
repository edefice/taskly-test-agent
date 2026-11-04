// Single source of truth for the files the unit test agent may change.
// Used by the PreToolUse hook and by the verification and commit steps, so that
// the model, the gate and the commit job cannot disagree about the boundary.

const TEST_FILE = [
  /^backend\/tests\/(?:[^/]+\/)*[^/]+\.test\.ts$/,
  /^frontend\/src\/(?:[^/]+\/)*[^/]+\.test\.tsx?$/,
];

// These files are imported by many tests. A change here can break tests the
// agent never touched, so callers run the whole package and report it separately.
const SHARED_TEST_SUPPORT = [
  /^backend\/tests\/(?:[^/]+\/)*[^/]+\.ts$/,
  /^frontend\/src\/test\/(?:[^/]+\/)*[^/]+\.tsx?$/,
  /^frontend\/src\/design-system\/mocks\.tsx$/,
];

// Allowed directories can still hold files that change how the tools behave.
const NEVER_ALLOWED = [
  /^frontend\/src\/test\/setup\.ts$/,
  /\.d\.ts$/,
  /(?:^|\/)[^/]*\.config\.[^/]+$/,
];

function isCanonicalRepoPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every(
    (segment) => segment !== '' && !segment.startsWith('.') && segment !== 'node_modules',
  );
}

/**
 * Classifies a repository-relative POSIX path.
 * @returns {'test' | 'shared-test-support' | null} null when the path is not allowed.
 */
export function classifyTestPath(path) {
  if (!isCanonicalRepoPath(path)) return null;
  if (NEVER_ALLOWED.some((pattern) => pattern.test(path))) return null;
  if (TEST_FILE.some((pattern) => pattern.test(path))) return 'test';
  if (SHARED_TEST_SUPPORT.some((pattern) => pattern.test(path))) return 'shared-test-support';
  return null;
}
