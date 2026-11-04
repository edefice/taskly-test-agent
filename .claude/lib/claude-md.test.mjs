import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TOOLS_ROOT } from './agent-definition.mjs';

const text = readFileSync(join(TOOLS_ROOT, 'CLAUDE.md'), 'utf8');

function section(title) {
  const match = new RegExp(`^## ${title}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(text);
  assert.ok(match, `CLAUDE.md has no section named ${title}`);
  return match[1];
}

describe('CLAUDE.md', () => {
  const rows = [...section('Dependency versions').matchAll(/^\| (backend|frontend) \| `([^`]+)` \| ([^ |]+) \|$/gm)];

  it('lists the key dependencies of both packages', () => {
    const listed = rows.map(([, pkg, name]) => `${pkg}/${name}`);
    for (const expected of ['backend/express', 'backend/@prisma/client', 'backend/vitest', 'frontend/react', 'frontend/vitest', 'frontend/@testing-library/react']) {
      assert.ok(listed.includes(expected), `missing ${expected}`);
    }
  });

  for (const pkg of ['backend', 'frontend']) {
    it(`states the same versions as ${pkg}/package.json`, () => {
      const manifest = JSON.parse(readFileSync(join(TOOLS_ROOT, pkg, 'package.json'), 'utf8'));
      const declared = { ...manifest.dependencies, ...manifest.devDependencies };
      for (const [, rowPackage, name, version] of rows) {
        if (rowPackage === pkg) assert.equal(version, declared[name], `${pkg}: ${name}`);
      }
    });
  }

  it('tells the agent to check a library version before reporting a bug', () => {
    assert.match(section('Rules for the agent'), /check its version/);
  });

  it('points only to files that exist', () => {
    for (const [, path] of section('Agent and skills').matchAll(/`((?:\.claude|scripts)\/[^`]+)`/g)) {
      assert.ok(existsSync(join(TOOLS_ROOT, path)), path);
    }
  });

  it('holds project knowledge only, because it is public and read by the agent in CI', () => {
    assert.doesNotMatch(text, /working-rules|progress\.md|Cloudfide|assignment|recruitment|wait for approval/i);
  });
});
