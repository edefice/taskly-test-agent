import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyTestPath } from './test-paths.mjs';

describe('classifyTestPath', () => {
  for (const path of [
    'backend/tests/router.test.ts',
    'backend/tests/nested/health.test.ts',
    'frontend/src/lib/http.test.ts',
    'frontend/src/features/todos/components/TodoList.test.tsx',
    'frontend/src/test/helpers.test.ts',
  ]) {
    it(`treats ${path} as a test`, () => {
      assert.equal(classifyTestPath(path), 'test');
    });
  }

  for (const path of [
    'backend/tests/fixture.ts',
    'backend/tests/helpers/app.ts',
    'frontend/src/test/todoFixture.ts',
    'frontend/src/test/render.tsx',
    'frontend/src/design-system/mocks.tsx',
  ]) {
    it(`treats ${path} as shared test support`, () => {
      assert.equal(classifyTestPath(path), 'shared-test-support');
    });
  }

  for (const path of [
    // Application code and project configuration.
    'backend/src/features/todos/router.ts',
    'frontend/src/lib/http.ts',
    'frontend/src/design-system/index.ts',
    'frontend/src/design-system/mocks.ts',
    'package.json',
    'backend/package.json',
    'backend/vitest.config.ts',
    'frontend/vite.config.ts',
    'backend/prisma/schema.prisma',
    'CLAUDE.md',
    // Allowed directories, but files that change how the tools behave.
    'frontend/src/test/setup.ts',
    'backend/tests/vitest.config.ts',
    'backend/tests/global.d.ts',
    'frontend/src/test/global.d.ts',
    // Allowed directories, but not TypeScript.
    'backend/tests/run.sh',
    'backend/tests/data.json',
    'frontend/src/test/__snapshots__/a.test.tsx.snap',
    'frontend/src/lib/http.test.js',
    // Test-like names outside the allowed roots.
    'backend/src/router.test.ts',
    'tests/router.test.ts',
    'frontend/tests/a.test.ts',
    // Agent, workflow and repository internals.
    '.claude/settings.json',
    '.claude/hooks/guard-tools.mjs',
    '.github/workflows/test-agent.yml',
    '.git/config',
    // Paths that are not canonical must never reach the patterns.
    'backend/tests/../src/router.ts',
    './backend/tests/router.test.ts',
    'backend/tests/./router.test.ts',
    'backend//tests/router.test.ts',
    '/backend/tests/router.test.ts',
    'backend\\tests\\router.test.ts',
    'backend/tests/.hidden.test.ts',
    'backend/tests/.env.test.ts',
    'backend/tests/node_modules/a.test.ts',
    'frontend/src/node_modules/a.test.ts',
    'backend/tests/a.test.ts\0.txt',
    '',
  ]) {
    it(`rejects ${JSON.stringify(path)}`, () => {
      assert.equal(classifyTestPath(path), null);
    });
  }

  for (const value of [undefined, null, 42, {}, ['backend/tests/a.test.ts']]) {
    it(`rejects the non-string value ${JSON.stringify(value)}`, () => {
      assert.equal(classifyTestPath(value), null);
    });
  }
});
