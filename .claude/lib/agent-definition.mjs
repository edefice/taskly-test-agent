// Reads the agent definition, so that code uses the model, skills and prompt version
// stated there and they cannot drift apart from what a report says.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_NAME = 'unit-test-agent';
export const TOOLS_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error('The agent definition has no frontmatter.');
  const fields = {};
  let listKey = null;
  for (const line of match[1].split('\n')) {
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && listKey) {
      fields[listKey].push(item[1].trim());
      continue;
    }
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!field) throw new Error('The agent definition has a frontmatter line that cannot be read.');
    const [, key, value] = field;
    listKey = value === '' ? key : null;
    fields[key] = value === '' ? [] : value;
  }
  return { fields, body: text.slice(match[0].length) };
}

export function parseAgentDefinition(text) {
  const { fields, body } = parseFrontmatter(text);
  const version = /^AGENT_PROMPT_VERSION: (\S+)$/m.exec(body);
  if (!version) throw new Error('The agent definition has no AGENT_PROMPT_VERSION.');
  if (typeof fields.model !== 'string') throw new Error('The agent definition has no model.');
  return {
    fields,
    name: fields.name,
    model: fields.model,
    tools: String(fields.tools ?? '').split(',').map((tool) => tool.trim()).filter(Boolean),
    skills: Array.isArray(fields.skills) ? fields.skills : [],
    promptVersion: version[1],
  };
}

export function readAgentDefinition(root = TOOLS_ROOT) {
  return parseAgentDefinition(readFileSync(join(root, '.claude/agents', `${AGENT_NAME}.md`), 'utf8'));
}

/** Returns the instructions of a skill, without its frontmatter. */
export function readSkillBody(name, root = TOOLS_ROOT) {
  if (!/^[a-z][a-z-]*$/.test(name)) throw new Error('Invalid skill name.');
  const text = readFileSync(join(root, '.claude/skills', name, 'SKILL.md'), 'utf8');
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}
