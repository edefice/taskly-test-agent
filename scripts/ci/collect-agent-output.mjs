#!/usr/bin/env node
// Gathers what the agent did into one directory, before the scan looks at it and anything leaves
// the job. Only this directory is uploaded, so the job has one thing to scan.
//
//   ROUND=<n> OUT=<dir> EXECUTION_FILE=<path> AGENT_OUTCOME=<outcome> collect-agent-output.mjs
//
// Writes agent.patch, agent.json and, when the agent left one, transcript.json.

import { copyFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireEnv, writeJson } from './lib/github.mjs';
import { collectPatch } from './lib/patch.mjs';

export function collectAgentOutput({ repo, out, round, executionFile, agentOutcome }) {
  mkdirSync(out, { recursive: true });
  const { paths, outside } = collectPatch(repo, join(out, 'agent.patch'));
  const hasTranscript = Boolean(executionFile) && existsSync(executionFile);
  if (hasTranscript) copyFileSync(executionFile, join(out, 'transcript.json'));
  const agent = { round, action_outcome: agentOutcome || 'unknown', paths, outside, has_transcript: hasTranscript };
  writeJson(join(out, 'agent.json'), agent);
  return agent;
}

function main(env = process.env) {
  const agent = collectAgentOutput({
    repo: realpathSync(env.GITHUB_WORKSPACE ?? process.cwd()),
    out: requireEnv('OUT', env),
    round: Number(requireEnv('ROUND', env)),
    executionFile: env.EXECUTION_FILE,
    agentOutcome: env.AGENT_OUTCOME,
  });
  process.stdout.write(`Round ${agent.round}: ${agent.paths.length} test file(s), ${agent.outside.length} outside the allowlist.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`collect-agent-output: ${error.message}\n`);
    process.exitCode = 1;
  }
}
