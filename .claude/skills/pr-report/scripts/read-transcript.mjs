// Reads what happened from a Claude Code transcript, so the report does not have to
// take the model's word for it. Accepts stream-json (one JSON object per line) and a
// single JSON array, which is what claude-code-action writes.

function parseMessages(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not one array, so it may still be one object per line.
    }
  }
  const messages = [];
  for (const line of trimmed.split('\n')) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // A transcript cut off by a crash ends in a partial line.
    }
  }
  return messages;
}

/**
 * @returns {{ skills: string[], tools: string[], model: string | null, turns: number | null,
 *   costUsd: number | null, structuredOutput: unknown, outcome: string | null, denials: number }}
 */
export function readTranscript(text) {
  const messages = parseMessages(String(text ?? ''));
  const skills = new Set();
  const tools = new Set();
  for (const message of messages) {
    if (message?.type !== 'assistant' || !Array.isArray(message.message?.content)) continue;
    for (const block of message.message.content) {
      if (block?.type !== 'tool_use') continue;
      tools.add(block.name);
      if (block.name === 'Skill' && typeof block.input?.skill === 'string') skills.add(block.input.skill);
    }
  }
  const init = messages.find((message) => message?.type === 'system' && message.subtype === 'init');
  const result = messages.findLast((message) => message?.type === 'result');
  return {
    skills: [...skills],
    tools: [...tools],
    model: typeof init?.model === 'string' ? init.model : null,
    turns: Number.isFinite(result?.num_turns) ? result.num_turns : null,
    costUsd: Number.isFinite(result?.total_cost_usd) ? result.total_cost_usd : null,
    structuredOutput: result?.structured_output ?? null,
    // success, error_max_turns, error_max_budget_usd, error_during_execution, or null after a crash.
    outcome: typeof result?.subtype === 'string' ? result.subtype : null,
    denials: Array.isArray(result?.permission_denials) ? result.permission_denials.length : 0,
  };
}
