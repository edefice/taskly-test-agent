// Compares what the agent says about existing tests with what the diff shows. In a real run its
// justification said an existing test was kept unchanged, while it had added an assertion to it.
// A mismatch is a warning in the report and never rejects tests, because the tests themselves
// went through the gate. The two kinds differ: not_mentioned compares the diff with the agent's
// list, so it is a fact. claims_unchanged reads the agent's words, so it is a heuristic.

const SAYS_UNCHANGED = /\b(?:unchanged|untouched|not (?:been )?(?:changed|modified|touched|altered)|did(?: not|n't) (?:change|modify|touch|alter)|without (?:changing|modifying|touching|altering)|(?:left|kept) as is)\b/i;

// A sentence has to be about tests, because "the application code is unchanged" can be true.
const saysTestsUnchanged = (text) =>
  String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => /\btests?\b/i.test(sentence) && SAYS_UNCHANGED.test(sentence));

/**
 * @param {object} [result] The agent result.
 * @param {object} [verification] The gate report.
 * @returns {{ path: string, kind: 'claims_unchanged' | 'not_mentioned', tests: string[] }[]}
 */
export function claimMismatches(result, verification) {
  if (!result) return [];
  const mismatches = [];
  for (const { path, changed_tests: tests = [] } of verification?.modified_test_files ?? []) {
    if (tests.length === 0) continue;
    const entry = result.existing_tests_changed?.find((item) => item.path === path);
    if (saysTestsUnchanged(entry?.justification) || saysTestsUnchanged(result.reasoning)) mismatches.push({ path, kind: 'claims_unchanged', tests });
    else if (!entry) mismatches.push({ path, kind: 'not_mentioned', tests });
  }
  return mismatches;
}
