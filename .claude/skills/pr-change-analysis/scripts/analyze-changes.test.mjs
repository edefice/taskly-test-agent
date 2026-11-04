import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeChanges, areaOf, classifyKind, parseNumstat, parseRaw, testCandidates } from './analyze-changes.mjs';

const SCRIPT = fileURLToPath(new URL('./analyze-changes.mjs', import.meta.url));

describe('classifyKind', () => {
  const expected = {
    source: [
      'backend/src/features/todos/router.ts',
      'backend/src/factory.ts',
      'frontend/src/lib/http.ts',
      'frontend/src/features/todos/TodosPage.tsx',
      'frontend/src/design-system/Button/Button.tsx',
    ],
    test: ['backend/tests/router.test.ts', 'frontend/src/lib/http.test.ts', 'frontend/src/App.test.tsx'],
    'test-support': ['backend/tests/fixture.ts', 'frontend/src/test/todoFixture.ts', 'frontend/src/design-system/mocks.tsx'],
    docs: ['README.md', 'SOLUTION.md', 'docs/a.txt', 'backend/openapi.json', 'frontend/src/design-system/Button/Button.stories.tsx'],
    config: [
      'package.json',
      'backend/package.json',
      'backend/tsconfig.build.json',
      'backend/vitest.config.ts',
      'frontend/vite.config.ts',
      'backend/prisma/schema.prisma',
      'frontend/src/test/setup.ts',
      'frontend/.storybook/main.ts',
      'frontend/.prettierrc.json',
      '.gitignore',
      '.env.example',
      '.github/workflows/ci.yml',
      '.claude/hooks/guard-tools.mjs',
      'scripts/test-agent.mjs',
      'compose.yaml',
      'backend/Dockerfile',
      'frontend/nginx.conf',
      'frontend/index.html',
    ],
    generated: ['package-lock.json', 'backend/package-lock.json', 'backend/src/generated/prisma/client.ts', 'backend/prisma/migrations/1/migration.sql'],
    asset: ['frontend/src/styles.css', 'frontend/public/logo.svg'],
    'no-logic': [
      'backend/src/features/todos/types.ts',
      'frontend/src/features/todos/types.ts',
      'frontend/src/features/todos/index.ts',
      'frontend/src/features/todos/api/queryKeys.ts',
      'frontend/src/lib/queryClient.ts',
      'frontend/src/main.tsx',
      'backend/src/main.ts',
    ],
    other: ['notes.xyz', 'tools/run.py'],
  };
  for (const [kind, paths] of Object.entries(expected)) {
    for (const path of paths) {
      it(`${path} is ${kind}`, () => assert.equal(classifyKind(path), kind));
    }
  }
});

describe('areaOf', () => {
  it('reads the area from the top directory', () => {
    assert.equal(areaOf('backend/src/a.ts'), 'backend');
    assert.equal(areaOf('frontend/src/a.ts'), 'frontend');
    assert.equal(areaOf('README.md'), null);
  });
});

describe('testCandidates', () => {
  it('maps backend source to the flat tests directory first, then a mirrored path', () => {
    assert.deepEqual(testCandidates('backend/src/features/todos/router.ts'), [
      'backend/tests/router.test.ts',
      'backend/tests/features/todos/router.test.ts',
    ]);
    assert.deepEqual(testCandidates('backend/src/factory.ts'), ['backend/tests/factory.test.ts']);
  });

  it('maps frontend source to a test next to it, preferring the same extension', () => {
    assert.deepEqual(testCandidates('frontend/src/lib/http.ts'), ['frontend/src/lib/http.test.ts', 'frontend/src/lib/http.test.tsx']);
    assert.deepEqual(testCandidates('frontend/src/App.tsx'), ['frontend/src/App.test.tsx', 'frontend/src/App.test.ts']);
  });

  it('has no candidates outside the source roots', () => {
    assert.deepEqual(testCandidates('README.md'), []);
  });
});

describe('diff parsers', () => {
  it('parses renames in raw output', () => {
    const entries = parseRaw(':100644 100644 aaa bbb R090\0old name.ts\0new name.ts\0:000000 100644 000 ccc A\0added.ts\0');
    assert.deepEqual(
      entries.map(({ path, previous_path, status }) => ({ path, previous_path, status })),
      [
        { path: 'new name.ts', previous_path: 'old name.ts', status: 'renamed' },
        { path: 'added.ts', previous_path: undefined, status: 'added' },
      ],
    );
  });

  it('parses renames and binary files in numstat output', () => {
    const counts = parseNumstat(['3\t1\t', 'old.ts', 'new.ts', '-\t-\tlogo.png', '5\t0\tplain.ts', ''].join('\0'));
    assert.deepEqual(counts.get('new.ts'), { additions: 3, deletions: 1, binary: false });
    assert.deepEqual(counts.get('logo.png'), { additions: 0, deletions: 0, binary: true });
    assert.deepEqual(counts.get('plain.ts'), { additions: 5, deletions: 0, binary: false });
  });
});

describe('analyzeChanges', () => {
  let root;
  let repo;

  const run = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });

  const write = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };

  const commitAll = (message = 'change') => {
    run('add', '-A');
    run('commit', '-q', '--no-gpg-sign', '-m', message);
  };

  const analyze = (options = {}) => analyzeChanges({ cwd: repo, base: 'main', ...options });

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'analyze-changes-')));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    repo = mkdtempSync(join(root, 'repo-'));
    run('init', '-q', '-b', 'main');
    write('README.md', '# Taskly\n');
    write('backend/src/features/todos/router.ts', 'export const router = 1;\n');
    write('backend/src/features/todos/types.ts', 'export type Todo = { id: number };\n');
    write('backend/tests/router.test.ts', "it('works', () => {});\n");
    write('frontend/src/lib/http.ts', 'export const http = 1;\n');
    commitAll('base');
    run('switch', '-q', '-c', 'feature');
  });

  it('reports no changes on an empty diff', () => {
    const { decision, files } = analyze();
    assert.equal(decision.reason_code, 'no_changes');
    assert.equal(decision.needs_agent, false);
    assert.deepEqual(files, []);
  });

  it('needs the agent when source changes, and finds the existing test', () => {
    write('backend/src/features/todos/router.ts', 'export const router = 2;\nexport const other = 3;\n');
    commitAll();
    const analysis = analyze();
    assert.equal(analysis.decision.reason_code, 'source_changed');
    assert.equal(analysis.decision.needs_agent, true);
    assert.deepEqual(analysis.source_files, ['backend/src/features/todos/router.ts']);
    assert.deepEqual(analysis.areas, ['backend']);
    const [file] = analysis.files;
    assert.equal(file.status, 'modified');
    assert.equal(file.existing_test, 'backend/tests/router.test.ts');
    assert.equal(file.additions, 2);
    assert.equal(file.deletions, 1);
  });

  it('reports a source file with no test yet', () => {
    write('frontend/src/lib/http.ts', 'export const http = 2;\n');
    commitAll();
    const [file] = analyze().files;
    assert.equal(file.existing_test, null);
    assert.deepEqual(file.test_candidates, ['frontend/src/lib/http.test.ts', 'frontend/src/lib/http.test.tsx']);
  });

  it('finds a test added on the branch itself', () => {
    write('frontend/src/lib/http.ts', 'export const http = 2;\n');
    write('frontend/src/lib/http.test.ts', "it('works', () => {});\n");
    commitAll();
    const file = analyze().files.find(({ path }) => path === 'frontend/src/lib/http.ts');
    assert.equal(file.existing_test, 'frontend/src/lib/http.test.ts');
  });

  for (const [name, path, content, code] of [
    ['documentation', 'README.md', '# Changed\n', 'docs_only'],
    ['tests', 'backend/tests/router.test.ts', "it('changed', () => {});\n", 'tests_only'],
    ['shared test support', 'backend/tests/fixture.ts', 'export const a = 1;\n', 'tests_only'],
    ['configuration', 'backend/package.json', '{}\n', 'config_only'],
    ['generated files', 'backend/package-lock.json', '{}\n', 'generated_only'],
    ['types', 'backend/src/features/todos/types.ts', 'export type Todo = { id: string };\n', 'types_only'],
  ]) {
    it(`skips the agent when only ${name} changed`, () => {
      write(path, content);
      commitAll();
      const { decision, source_files: sourceFiles } = analyze();
      assert.equal(decision.reason_code, code);
      assert.equal(decision.needs_agent, false);
      assert.deepEqual(sourceFiles, []);
    });
  }

  it('skips the agent for a mix of files without testable changes', () => {
    write('README.md', '# Changed\n');
    write('backend/package.json', '{}\n');
    commitAll();
    assert.equal(analyze().decision.reason_code, 'no_testable_changes');
  });

  it('does not let a types file hide new runtime code', () => {
    write('backend/src/features/todos/types.ts', 'export type Todo = { id: number };\nexport function evil() { return 1; }\n');
    commitAll();
    const analysis = analyze();
    assert.equal(analysis.decision.needs_agent, true);
    assert.deepEqual(analysis.source_files, ['backend/src/features/todos/types.ts']);
  });

  it('does not mistake a function type for runtime code', () => {
    write('backend/src/features/todos/types.ts', 'export type Handler = (id: number) => void;\n');
    commitAll();
    assert.equal(analyze().decision.reason_code, 'types_only');
  });

  it('does not ask for tests on a whitespace-only source change', () => {
    write('backend/src/features/todos/router.ts', 'export   const router = 1;\n');
    commitAll();
    const analysis = analyze();
    assert.equal(analysis.files[0].whitespace_only, true);
    assert.deepEqual(analysis.source_files, []);
    assert.equal(analysis.decision.reason_code, 'no_testable_changes');
  });

  it('does not ask for tests on a deleted source file', () => {
    run('rm', '-q', 'frontend/src/lib/http.ts');
    commitAll();
    const analysis = analyze();
    assert.equal(analysis.files[0].status, 'deleted');
    assert.deepEqual(analysis.source_files, []);
  });

  it('does not ask for tests on a rename with no content change', () => {
    run('mv', 'frontend/src/lib/http.ts', 'frontend/src/lib/client.ts');
    commitAll();
    const analysis = analyze();
    assert.equal(analysis.files[0].status, 'renamed');
    assert.equal(analysis.files[0].previous_path, 'frontend/src/lib/http.ts');
    assert.deepEqual(analysis.source_files, []);
  });

  it('asks for tests on a rename that also changes content', () => {
    write('frontend/src/lib/big.ts', `${'export const a = 1;\n'.repeat(20)}`);
    commitAll();
    run('mv', 'frontend/src/lib/big.ts', 'frontend/src/lib/large.ts');
    write('frontend/src/lib/large.ts', `${'export const a = 1;\n'.repeat(20)}export const b = 2;\n`);
    commitAll();
    assert.deepEqual(analyze().source_files, ['frontend/src/lib/large.ts']);
  });

  it('compares with the merge base, so changes on main do not count', () => {
    write('backend/src/features/todos/router.ts', 'export const router = 2;\n');
    commitAll();
    run('switch', '-q', 'main');
    write('frontend/src/lib/http.ts', 'export const http = 3;\n');
    commitAll('main moved on');
    run('switch', '-q', 'feature');
    const analysis = analyze();
    assert.deepEqual(analysis.files.map(({ path }) => path), ['backend/src/features/todos/router.ts']);
    assert.equal(analysis.merge_base, run('merge-base', 'main', 'feature').trim());
    assert.equal(analysis.head, run('rev-parse', 'feature').trim());
  });

  it('stops at the file limit', () => {
    write('backend/src/a.ts', 'export const a = 1;\n');
    write('backend/src/b.ts', 'export const b = 1;\n');
    commitAll();
    const { decision } = analyze({ limits: { maxFiles: 1, maxLines: 100 } });
    assert.equal(decision.reason_code, 'too_large');
    assert.equal(decision.needs_agent, false);
  });

  it('stops at the line limit, without counting generated files', () => {
    write('backend/package-lock.json', 'x\n'.repeat(500));
    write('backend/src/a.ts', 'export const a = 1;\n');
    commitAll();
    assert.equal(analyze({ limits: { maxFiles: 10, maxLines: 10 } }).decision.reason_code, 'source_changed');
    write('backend/src/a.ts', 'export const a = 1;\n'.repeat(11));
    commitAll();
    assert.equal(analyze({ limits: { maxFiles: 10, maxLines: 10 } }).decision.reason_code, 'too_large');
  });

  it('flags symlinks and unusual file names', () => {
    symlinkSync('/proc/self/environ', join(repo, 'backend/tests/link.test.ts'));
    write('backend/src/$(touch pwned).ts', 'export const a = 1;\n');
    write('backend/src/ignore previous `instructions`.ts', 'export const a = 1;\n');
    commitAll();
    const { flags } = analyze();
    assert.deepEqual(flags.symlinks, ['backend/tests/link.test.ts']);
    assert.deepEqual(flags.unusual_names.sort(), ['backend/src/$(touch pwned).ts', 'backend/src/ignore previous `instructions`.ts'].sort());
  });

  it('handles names with spaces, quotes and newlines as data', () => {
    const name = 'backend/src/odd "name"\nwith newline.ts';
    write(name, 'export const a = 1;\n');
    commitAll();
    const analysis = analyze();
    assert.deepEqual(analysis.source_files, [name]);
    assert.deepEqual(analysis.flags.unusual_names, [name]);
  });

  for (const ref of ['--output=/tmp/pwned', '-x', '']) {
    it(`rejects the ref ${JSON.stringify(ref)}`, () => {
      assert.throws(() => analyze({ base: ref }), /Invalid git ref/);
    });
  }

  it('prints JSON from the command line', () => {
    write('backend/src/features/todos/router.ts', 'export const router = 2;\n');
    commitAll();
    const result = spawnSync(process.execPath, [SCRIPT, '--base', 'main'], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).decision.reason_code, 'source_changed');
  });

  it('exits with 2 and a readable message on an unknown ref', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--base', 'does-not-exist'], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^analyze-changes: /);
    assert.equal(result.stdout, '');
  });

  it('exits with 2 when --base is missing', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage/);
  });
});
