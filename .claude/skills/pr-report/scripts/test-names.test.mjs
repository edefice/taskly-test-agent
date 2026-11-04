import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countUndescribedTests, crossCheckWithVerification } from './validate-result.mjs';

const FILE = 'backend/tests/a.test.ts';
const test = (title, path = FILE) => ({ path, title });
const entry = (name, file = FILE) => ({ file, name, behavior: 'Does something.' });

describe('countUndescribedTests', () => {
  it('accepts the exact title', () => {
    assert.equal(countUndescribedTests([test('returns 404')], [entry('returns 404')]), 0);
  });

  for (const name of ['router returns 404', 'router > returns 404', 'router › returns 404', 'api router returns 404']) {
    it(`accepts the full name ${JSON.stringify(name)}`, () => {
      assert.equal(countUndescribedTests([test('returns 404')], [entry(name)]), 0);
    });
  }

  it('accepts several tests in full names', () => {
    assert.equal(countUndescribedTests([test('returns 404'), test('returns 422')], [entry('router returns 404'), entry('router returns 422')]), 0);
  });

  it('counts a test with no entry', () => {
    assert.equal(countUndescribedTests([test('returns 404')], [entry('returns 500')]), 1);
  });

  it('does not accept a name that only ends in the same word', () => {
    assert.equal(countUndescribedTests([test('404')], [entry('returns404')]), 1);
  });

  it('does not accept a name that holds the title in the middle', () => {
    assert.equal(countUndescribedTests([test('returns 404')], [entry('returns 404 for a user')]), 1);
    assert.equal(countUndescribedTests([test('returns 404')], [entry('router returns 404 for a user')]), 1);
  });

  it('does not take an entry from another file', () => {
    assert.equal(countUndescribedTests([test('returns 404')], [entry('router returns 404', 'backend/tests/b.test.ts')]), 1);
    assert.equal(countUndescribedTests([test('returns 404')], [entry('returns 404', 'backend/tests/b.test.ts')]), 1);
  });

  it('rejects two full names that fit one title, because either could be it', () => {
    assert.equal(countUndescribedTests([test('returns 404')], [entry('get returns 404'), entry('put returns 404')]), 1);
  });

  it('rejects one full name that fits two titles, because it describes only one of them', () => {
    assert.equal(countUndescribedTests([test('returns 404'), test('404')], [entry('router returns 404')]), 2);
  });

  it('does not let an exact entry for one test stand in for another', () => {
    assert.equal(countUndescribedTests([test('404'), test('returns 404')], [entry('returns 404')]), 1);
  });

  it('counts tests per file', () => {
    assert.equal(countUndescribedTests([test('a', 'x.test.ts'), test('a', 'y.test.ts')], [entry('d a', 'x.test.ts')]), 1);
  });
});

describe('crossCheckWithVerification with full names', () => {
  const verification = { changed_files: [{ path: FILE, class: 'test' }], new_tests: [test('returns 404')] };
  const result = (name) => ({ files: [{ path: FILE, action: 'created' }], tests: [entry(name)], existing_tests_changed: [] });

  it('accepts the format that cost a repair round in real runs', () => {
    assert.deepEqual(crossCheckWithVerification(result('router returns 404'), verification), []);
  });

  it('still rejects a test with no entry, without repeating values', () => {
    assert.deepEqual(crossCheckWithVerification(result('something else'), verification), ['1 new test(s) have no entry in the result with their title.']);
  });
});
