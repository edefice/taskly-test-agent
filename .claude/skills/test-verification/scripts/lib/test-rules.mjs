// Rules for test files that code can check without running them. They compare the
// new content with the version in HEAD, so existing code in a file is not blamed.

const FORBIDDEN_LINE_RULES = [
  {
    rule: 'focused-or-skipped-test',
    pattern: /\b(?:it|test|describe|suite|bench)(?:\.\w+)*\.(?:only|skip|skipIf|runIf|todo|fails)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|\b(?:ctx|context|task)\.skip\s*\(/,
    message: 'Tests must not be focused, skipped or marked as expected to fail.',
  },
  {
    rule: 'tautological-assertion',
    pattern: /\bexpect\(\s*(true|false|null|undefined|\d+|'[^']*'|"[^"]*")\s*\)(?:\.not)?\.(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)|\bexpect\(\s*(?:true|\d*[1-9]\d*|'[^']+'|"[^"]+")\s*\)\.toBeTruthy\(\)|\bexpect\(\s*(?:false|0|null|undefined)\s*\)\.toBeFalsy\(\)/,
    message: 'An assertion on two constants cannot fail, so it checks nothing.',
  },
  {
    rule: 'snapshot-assertion',
    pattern: /\.toMatchSnapshot\(|\.toMatchFileSnapshot\(/,
    message: 'Assert on behavior, roles and text. Snapshot files are outside the allowlist.',
  },
];

const TEST_TITLE =
  /\b(?:it|test)(?:\.each\s*(?:`[^`]*`|\([\s\S]{0,4000}?\))\s*)?\(\s*(?:(['"])((?:\\.|(?!\1)[^\\\n])*)\1|`((?:\\.|[^`\\])*)`)/g;
const ASSERTION = /\bexpect(?:\.\w+)?\s*\(/g;

const IMPORT_STATEMENT = /^import\b[^;'"]*?(?:from\s+)?['"][^'"\n]+['"];?[ \t]*$/gm;

function testTitles(content) {
  return [...content.matchAll(TEST_TITLE)].map((match) => (match[2] ?? match[3]).replace(/\\(.)/g, '$1'));
}

function countMatches(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

/** Lines in `after` that `before` does not have, respecting how many times each appears. */
function addedLines(before, after) {
  const remaining = new Map();
  for (const line of before.split('\n')) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added = [];
  for (const [index, line] of after.split('\n').entries()) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added.push({ number: index + 1, text: line });
  }
  return added;
}

/** Finds where a call ends, from inside its parentheses. Strings and comments do not count. Null if it cannot tell. */
function endOfCall(content, start) {
  let depth = 1;
  let index = start;
  while (index < content.length) {
    const character = content[index];
    if (character === '/' && content[index + 1] === '/') {
      const end = content.indexOf('\n', index);
      if (end === -1) return null;
      index = end;
    } else if (character === '/' && content[index + 1] === '*') {
      const end = content.indexOf('*/', index + 2);
      if (end === -1) return null;
      index = end + 1;
    } else if (character === "'" || character === '"' || character === '`') {
      index += 1;
      while (index < content.length && content[index] !== character) index += content[index] === '\\' ? 2 : 1;
    } else if ('([{'.includes(character)) {
      depth += 1;
    } else if (')]}'.includes(character)) {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return null;
}

/** The code of each test by title, without whitespace, so formatting alone is not a change. */
function testBodies(content) {
  const bodies = new Map();
  for (const match of content.matchAll(TEST_TITLE)) {
    const title = (match[2] ?? match[3]).replace(/\\(.)/g, '$1');
    const start = match.index + match[0].length;
    const end = endOfCall(content, start);
    const body = end === null ? null : content.slice(start, end).replace(/\s+/g, '');
    bodies.set(title, [...(bodies.get(title) ?? []), body]);
  }
  return bodies;
}

const sameBodies = (one, other) => one.length === other.length && [...one].sort().join('\0') === [...other].sort().join('\0');

/**
 * Compares an existing test file with its new version, from the code alone. Lists the tests that
 * are in both versions with different code. A test whose end cannot be found is left out,
 * because this goes into a warning, and a false alarm is worse than a gap.
 */
export function compareTestFile({ before, after }) {
  const was = testBodies(before);
  const changedTests = [];
  for (const [title, bodies] of testBodies(after)) {
    const earlier = was.get(title);
    if (!earlier || [...earlier, ...bodies].includes(null)) continue;
    if (!sameBodies(earlier, bodies)) changedTests.push(title);
  }
  return {
    added_lines: addedLines(before, after).length,
    removed_lines: addedLines(after, before).length,
    changed_tests: changedTests,
  };
}

/**
 * Checks one changed test or test support file.
 * @param {{ path: string, before: string | null, after: string, isTest: boolean }} file
 *   `before` is null when the file is new.
 */
export function checkTestFile({ path, before, after, isTest }) {
  const previous = before ?? '';
  const violations = [];
  const added = addedLines(previous, after);

  for (const { rule, pattern, message } of FORBIDDEN_LINE_RULES) {
    for (const { number, text } of added) {
      if (pattern.test(text)) violations.push({ rule, path, line: number, message });
    }
  }

  if (before !== null && isTest) {
    const remainingTitles = new Set(testTitles(after));
    for (const title of new Set(testTitles(before))) {
      if (!remainingTitles.has(title)) {
        violations.push({
          rule: 'removed-test',
          path,
          message: `The existing test ${JSON.stringify(title)} was removed or renamed. If the code under test changed its behavior, report that instead.`,
        });
      }
    }
    const assertionsBefore = countMatches(before, ASSERTION);
    const assertionsAfter = countMatches(after, ASSERTION);
    if (assertionsAfter < assertionsBefore) {
      violations.push({
        rule: 'fewer-assertions',
        path,
        message: `The file went from ${assertionsBefore} to ${assertionsAfter} assertions. Existing assertions must not be weakened.`,
      });
    }
  }

  const titlesBefore = new Set(testTitles(previous));
  return {
    violations,
    newTests: isTest ? [...new Set(testTitles(after))].filter((title) => !titlesBefore.has(title)) : [],
    // Changing existing lines is allowed only when the pull request requires it, so the
    // report has to show it and explain why. A new test usually needs a new import, and
    // that changes no behavior of the existing tests.
    changedExistingLines: before === null ? 0 : addedLines(after, previous.replace(IMPORT_STATEMENT, '')).filter(({ text }) => text.trim() !== '').length,
  };
}
