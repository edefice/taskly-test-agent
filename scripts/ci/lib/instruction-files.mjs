// Files that Claude Code reads as instructions and that the action does not restore from the base
// commit. In a pull request they would reach the model as project instructions, outside the tags
// that mark data as untrusted.
//
// Checked on Claude Code 2.1.317 with the flags of CI, not only in its documentation, which says
// AGENTS.md is not read. It is read, in the root and on demand from a subdirectory. So are
// CLAUDE.md in a subdirectory, and .claude/CLAUDE.md and .claude/rules in a subdirectory. Skills in
// a nested .claude/ are from the documentation. CLAUDE.local.md was not read with these flags, and
// the documentation lists it, so it stays here in case the flags change. The documentation reads
// .mcp.json only from the root, and the action restores that one.
//
// Names ignore case, because agents.md was read on a filesystem that ignores case, and the cost of
// removing a file by mistake is small: the file stays in the pull request and leaves only the
// checkout of the job with the agent.

const NESTED_CONFIG = /^\.claude$/i;
const NAME = /^(?:CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$/i;
// The action replaces these with the versions from the base commit.
const RESTORED_BY_THE_ACTION = new Set(['CLAUDE.md', 'CLAUDE.local.md']);

/** @param {string} path A repository-relative POSIX path. */
export function isInstructionFile(path) {
  const segments = path.split('/');
  if (segments[0] === '.claude') return false;
  if (segments.some((segment) => NESTED_CONFIG.test(segment))) return true;
  if (RESTORED_BY_THE_ACTION.has(path)) return false;
  return NAME.test(segments.at(-1));
}
