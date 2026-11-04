import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { applyPatch, collectPatch, inspectIndex, parseRawDiff, refusalFor } from './patch.mjs';

const TEST = 'backend/tests/a.test.ts';
const COMMITTER = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const SHA = 'a'.repeat(40);

describe('parseRawDiff', () => {
  it('reads entries, with any name', () => {
    const output = `:000000 100644 ${SHA} ${SHA} A\0a b\nc.ts\0:100644 100644 ${SHA} ${SHA} M\0d.ts\0`;
    assert.deepEqual(parseRawDiff(output), [
      { path: 'a b\nc.ts', oldMode: '000000', newMode: '100644', status: 'A' },
      { path: 'd.ts', oldMode: '100644', newMode: '100644', status: 'M' },
    ]);
  });

  it('reads nothing from an empty diff', () => {
    assert.deepEqual(parseRawDiff(''), []);
  });
});

describe('refusalFor', () => {
  it('allows a new or changed regular test file', () => {
    assert.equal(refusalFor({ path: TEST, newMode: '100644', status: 'A' }), null);
    assert.equal(refusalFor({ path: TEST, newMode: '100644', status: 'M' }), null);
  });

  for (const [name, entry, expected] of [
    ['a file outside the allowlist', { path: 'backend/src/a.ts', newMode: '100644', status: 'M' }, /outside the test allowlist/],
    ['a workflow', { path: '.github/workflows/ci.yml', newMode: '100644', status: 'A' }, /outside the test allowlist/],
    ['package.json', { path: 'backend/package.json', newMode: '100644', status: 'M' }, /outside the test allowlist/],
    ['a deleted test', { path: TEST, newMode: '000000', status: 'D' }, /not a plain addition/],
    ['a symbolic link', { path: TEST, newMode: '120000', status: 'A' }, /mode 120000/],
    ['a submodule', { path: TEST, newMode: '160000', status: 'A' }, /mode 160000/],
    ['an executable file', { path: TEST, newMode: '100755', status: 'M' }, /mode 100755/],
    ['a type change', { path: TEST, newMode: '120000', status: 'T' }, /not a plain addition/],
  ]) {
    it(`refuses ${name}`, () => {
      assert.match(refusalFor(entry), expected);
    });
  }
});

describe('with real git', () => {
  let root;
  let repo;
  const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...COMMITTER } });
  const write = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const clean = () => run('status', '--porcelain', '--untracked-files=all') === '';

  /** Makes a patch from a change, and leaves the repository clean for applying it. */
  const patchOf = (change) => {
    change();
    run('add', '-A');
    const text = run('diff', '--cached', '--binary', '--full-index', 'HEAD');
    run('reset', '--hard', '-q', 'HEAD');
    run('clean', '-fdq');
    const file = join(root, `patch-${Math.random()}.diff`);
    writeFileSync(file, text);
    return file;
  };

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'patch-test-')));
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    repo = mkdtempSync(join(root, 'repo-'));
    run('init', '-q', '-b', 'main');
    write(TEST, 'old\n');
    write('backend/src/a.ts', 'source\n');
    write('.github/workflows/ci.yml', 'name: ci\n');
    run('add', '-A');
    run('commit', '-q', '--no-gpg-sign', '-m', 'base');
  });

  describe('applyPatch', () => {
    it('applies a new and a changed test, into the index and the tree', () => {
      const patch = patchOf(() => {
        write(TEST, 'new\n');
        write('backend/tests/b.test.ts', 'b\n');
      });
      const result = applyPatch(repo, patch);
      assert.deepEqual(result, { applied: true, paths: [TEST, 'backend/tests/b.test.ts'], problems: [] });
      assert.equal(readFileSync(join(repo, TEST), 'utf8'), 'new\n');
      assert.deepEqual(inspectIndex(repo).problems, []);
    });

    for (const [name, change, path, reason] of [
      ['a change to source', () => write('backend/src/a.ts', 'evil\n'), 'backend/src/a.ts', /allowlist/],
      ['a change to a workflow', () => write('.github/workflows/ci.yml', 'evil\n'), '.github/workflows/ci.yml', /allowlist/],
      ['a deleted test', () => rmSync(join(repo, TEST)), TEST, /not a plain addition/],
      ['a symbolic link in an allowed path', () => symlinkSync('/etc/hosts', join(repo, 'backend/tests/link.test.ts')), 'backend/tests/link.test.ts', /mode 120000/],
      ['a test made executable', () => chmodSync(join(repo, TEST), 0o755), TEST, /mode 100755/],
    ]) {
      it(`refuses ${name}, and leaves nothing behind`, () => {
        const result = applyPatch(repo, patchOf(change));
        assert.equal(result.applied, false);
        assert.ok(result.problems.some((problem) => problem.path === path && reason.test(problem.reason)), JSON.stringify(result));
        assert.ok(clean(), 'the tree went back to HEAD');
      });
    }

    it('refuses the whole patch when one file is not allowed, and keeps the good one out too', () => {
      const patch = patchOf(() => {
        write('backend/tests/good.test.ts', 'good\n');
        write('backend/src/evil.ts', 'evil\n');
      });
      assert.equal(applyPatch(repo, patch).applied, false);
      assert.equal(existsSync(join(repo, 'backend/tests/good.test.ts')), false);
      assert.equal(existsSync(join(repo, 'backend/src/evil.ts')), false);
      assert.ok(clean());
    });

    it('is not fooled by a patch written so a text parser sees only a test file', () => {
      // The first part looks like the whole patch. Git also reads the plain diff after it.
      const hidden = [
        `diff --git a/${TEST} b/${TEST}`,
        '--- a/backend/tests/a.test.ts',
        '+++ b/backend/tests/a.test.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '--- a/backend/src/a.ts',
        '+++ b/backend/src/a.ts',
        '@@ -1 +1 @@',
        '-source',
        '+evil',
        '',
      ].join('\n');
      const file = join(root, 'hidden.diff');
      writeFileSync(file, hidden);
      const result = applyPatch(repo, file);
      assert.equal(result.applied, false);
      assert.equal(readFileSync(join(repo, 'backend/src/a.ts'), 'utf8'), 'source\n');
      assert.ok(clean());
    });

    it('reports a patch that does not apply, and stays clean', () => {
      const patch = patchOf(() => write(TEST, 'new\n'));
      write(TEST, 'moved on\n');
      run('add', '-A');
      run('commit', '-q', '--no-gpg-sign', '-m', 'next');
      const result = applyPatch(repo, patch);
      assert.equal(result.applied, false);
      assert.match(result.problems[0].reason, /does not apply/);
      assert.ok(clean());
    });

    it('reports text that is no patch', () => {
      const file = join(root, 'garbage.diff');
      writeFileSync(file, 'this is not a patch\n');
      assert.equal(applyPatch(repo, file).applied, false);
    });
  });

  describe('collectPatch', () => {
    const out = () => join(root, `out-${Math.random()}.diff`);

    it('collects new and changed tests, and the patch applies on a clean checkout', () => {
      write(TEST, 'new\n');
      write('backend/tests/b.test.ts', 'b\n');
      const file = out();
      assert.deepEqual(collectPatch(repo, file), { paths: [TEST, 'backend/tests/b.test.ts'], outside: [] });
      run('reset', '--hard', '-q', 'HEAD');
      run('clean', '-fdq');
      assert.equal(applyPatch(repo, file).applied, true);
      assert.equal(readFileSync(join(repo, 'backend/tests/b.test.ts'), 'utf8'), 'b\n');
    });

    it('leaves out and reports a change outside the allowlist', () => {
      write(TEST, 'new\n');
      write('backend/src/a.ts', 'evil\n');
      write('backend/src/new.ts', 'evil\n');
      const file = out();
      assert.deepEqual(collectPatch(repo, file), { paths: [TEST], outside: ['backend/src/a.ts', 'backend/src/new.ts'] });
      const patch = readFileSync(file, 'utf8');
      assert.ok(patch.includes(TEST));
      assert.ok(!patch.includes('evil'));
    });

    it('does not count what the action restores from the base as a change by the agent', () => {
      write('.claude/settings.json', '{}\n');
      write('CLAUDE.md', 'restored\n');
      write('.claude-pr/x', 'moved\n');
      assert.deepEqual(collectPatch(repo, out()).outside, []);
    });

    it('still reports a path that only looks like one the action restores', () => {
      write('.claude-evil/x', 'x\n');
      write('CLAUDE.md.bak', 'x\n');
      assert.deepEqual(collectPatch(repo, out()).outside.sort(), ['.claude-evil/x', 'CLAUDE.md.bak']);
    });

    it('writes an empty patch when nothing changed', () => {
      const file = out();
      assert.deepEqual(collectPatch(repo, file), { paths: [], outside: [] });
      assert.equal(readFileSync(file, 'utf8'), '');
    });

    it('writes an empty patch when only forbidden paths changed', () => {
      write('backend/src/a.ts', 'evil\n');
      const file = out();
      assert.deepEqual(collectPatch(repo, file), { paths: [], outside: ['backend/src/a.ts'] });
      assert.equal(readFileSync(file, 'utf8'), '');
    });

    it('keeps a deleted test in the patch, so that applying it is refused', () => {
      rmSync(join(repo, TEST));
      const file = out();
      collectPatch(repo, file);
      run('reset', '--hard', '-q', 'HEAD');
      const result = applyPatch(repo, file);
      assert.equal(result.applied, false);
      assert.match(result.problems[0].reason, /not a plain addition/);
    });
  });
});
