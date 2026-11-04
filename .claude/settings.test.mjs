import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const readJson = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

describe('settings.json', () => {
  const settings = readJson('./settings.json');

  it('runs the guard on every tool call and blocks if the guard fails', () => {
    const [entry, ...others] = settings.hooks.PreToolUse;
    assert.equal(others.length, 0);
    assert.equal(entry.matcher, '*');
    const [hook] = entry.hooks;
    assert.equal(hook.command, 'node');
    assert.deepEqual(hook.args, ['${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-tools.mjs']);
    assert.equal(hook.onFailure, 'block');
  });

  for (const subcommand of ['commit', 'push', 'merge', 'rebase', 'reset', 'stash', 'tag']) {
    it(`denies git ${subcommand} also with options in front of it`, () => {
      for (const rule of [`Bash(git ${subcommand} *)`, `Bash(git * ${subcommand} *)`, `Bash(git * ${subcommand})`]) {
        assert.ok(settings.permissions.deny.includes(rule), `missing ${rule}`);
      }
    });
  }

  for (const rule of ['Bash(git checkout -- *)', 'Bash(gh pr create *)', 'Bash(gh pr merge *)']) {
    it(`denies ${rule}`, () => {
      assert.ok(settings.permissions.deny.includes(rule));
    });
  }

  it('grants nothing: capabilities are given per run through command line flags', () => {
    assert.equal(settings.permissions.allow, undefined);
  });
});

describe('agent-run.settings.json', () => {
  it('blocks the file tools from leaving the working directory', () => {
    const { permissions } = readJson('./agent-run.settings.json');
    assert.equal(permissions.blockReadsOutsideWorkingDirectories, true);
    assert.equal(permissions.blockWritesOutsideWorkingDirectories, true);
  });
});
