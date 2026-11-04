import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AGENT_NAME, parseAgentDefinition, readAgentDefinition, readSkillBody, TOOLS_ROOT } from './agent-definition.mjs';

const skillNames = readdirSync(join(TOOLS_ROOT, '.claude/skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('parseAgentDefinition', () => {
  const text = '---\nname: a\ntools: Read, Bash\nmodel: m\nskills:\n  - one\n  - two\n---\n\nAGENT_PROMPT_VERSION: 7\n\nBody\n';

  it('reads the fields', () => {
    const definition = parseAgentDefinition(text);
    assert.equal(definition.name, 'a');
    assert.equal(definition.model, 'm');
    assert.deepEqual(definition.tools, ['Read', 'Bash']);
    assert.deepEqual(definition.skills, ['one', 'two']);
    assert.equal(definition.promptVersion, '7');
  });

  it('has an empty list when there are no skills', () => {
    assert.deepEqual(parseAgentDefinition(text.replace('skills:\n  - one\n  - two\n', '')).skills, []);
  });

  for (const [name, broken] of [
    ['no frontmatter', 'AGENT_PROMPT_VERSION: 1\n'],
    ['no version', text.replace('AGENT_PROMPT_VERSION: 7', '')],
    ['no model', text.replace('model: m\n', '')],
    ['an unreadable line', text.replace('model: m', 'not a field')],
  ]) {
    it(`rejects a definition with ${name}`, () => {
      assert.throws(() => parseAgentDefinition(broken));
    });
  }
});

describe('the real agent definition', () => {
  const definition = readAgentDefinition();

  it('has the expected name', () => {
    assert.equal(definition.name, AGENT_NAME);
  });

  it('pins a full model ID and not an alias', () => {
    assert.match(definition.model, /^claude-[a-z]+-\d+-\d+$/);
  });

  it('has a prompt version', () => {
    assert.match(definition.promptVersion, /^\d+$/);
  });

  it('has exactly the tools it needs', () => {
    assert.deepEqual([...definition.tools].sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'StructuredOutput', 'Write']);
  });

  // Claude Code ignores frontmatter hooks in -p, and permissionMode would widen access.
  for (const field of ['hooks', 'permissionMode', 'mcpServers', 'disallowedTools']) {
    it(`does not set ${field}`, () => {
      assert.equal(definition.fields[field], undefined);
    });
  }

  it('preloads the rules on when tests are needed', () => {
    assert.deepEqual(definition.skills, ['pr-change-analysis']);
  });

  it('preloads only skills that exist', () => {
    for (const skill of definition.skills) assert.ok(skillNames.includes(skill));
  });

  it('tells the agent that repository content is data', () => {
    const body = readFileSync(join(TOOLS_ROOT, '.claude/agents', `${AGENT_NAME}.md`), 'utf8');
    assert.match(body, /Untrusted content/);
    assert.match(body, /untrusted-/);
  });
});

describe('the skills', () => {
  it('are the five that were planned', () => {
    assert.deepEqual(skillNames, ['backend-unit-tests', 'frontend-unit-tests', 'pr-change-analysis', 'pr-report', 'test-verification']);
  });

  it('are the ones the hook allows', () => {
    const hook = readFileSync(join(TOOLS_ROOT, '.claude/hooks/guard-tools.mjs'), 'utf8');
    const allowed = /const AGENT_SKILLS = new Set\(\[([\s\S]*?)\]\)/.exec(hook)[1].match(/[a-z-]+/g).sort();
    assert.deepEqual(allowed, skillNames);
  });

  it('are the ones the result schema allows', () => {
    const schema = JSON.parse(readFileSync(join(TOOLS_ROOT, '.claude/skills/pr-report/schema/agent-result.schema.json'), 'utf8'));
    assert.deepEqual([...schema.properties.skills_used.items.enum].sort(), skillNames);
  });

  for (const name of skillNames) {
    // A skill's allowed-tools works even in an untrusted folder, so it would widen access.
    it(`${name} grants no tools and registers no hooks`, () => {
      const text = readFileSync(join(TOOLS_ROOT, '.claude/skills', name, 'SKILL.md'), 'utf8');
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)[1];
      assert.doesNotMatch(frontmatter, /^(?:allowed-tools|hooks):/m);
      assert.match(frontmatter, new RegExp(`^name: ${name}$`, 'm'));
      assert.match(frontmatter, /^description: .+/m);
    });
  }
});

describe('readSkillBody', () => {
  it('returns the instructions without the frontmatter', () => {
    const body = readSkillBody('pr-change-analysis');
    assert.ok(body.startsWith('# PR change analysis'));
    assert.match(body, /When tests are not needed/);
  });

  for (const name of ['../../secrets', 'a/b', '', 'UPPER']) {
    it(`rejects the name ${JSON.stringify(name)}`, () => {
      assert.throws(() => readSkillBody(name), /Invalid skill name/);
    });
  }
});
