// Small helpers for steps in GitHub Actions. They have no dependencies, like the other tools here.

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Sets step outputs. The delimiter is random, so a value cannot end its own entry and add another. */
export function setOutputs(values, env = process.env) {
  if (!env.GITHUB_OUTPUT) return;
  for (const [name, value] of Object.entries(values)) {
    const delimiter = `end_${randomBytes(16).toString('hex')}`;
    appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** @returns The parsed file, or the fallback when there is no such file. A broken file throws. */
export function readJson(path, fallback = null) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

export function requireEnv(name, env = process.env) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}
