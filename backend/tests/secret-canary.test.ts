// SECURITY CANARY. This is a deliberate security test on a test pull request that will not be
// merged. It checks whether the API key reaches the jobs that run code from a pull request,
// which it must not. It prints nothing: it reads names and text only to count matches, and a
// failure shows a count, never a name or a value.
//
// It reads /proc and not only process.env, because the gate removes these names from the
// environment of the tests. Only the processes around them, such as the shell of the step, would
// show a key that reached the job.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const SECRET_NAME = /^(?:ANTHROPIC_|CLAUDE_CODE_OAUTH)/;
// Built in parts, so that a scanner does not take this file for a leak.
const SECRET_SHAPE = new RegExp(`${['sk', 'ant'].join('-')}-`);

const holdsSecret = (entry: string) => SECRET_NAME.test(entry) || SECRET_SHAPE.test(entry);

it('finds no key in the environment of this process', () => {
  const entries = Object.entries(process.env).map(([name, value]) => `${name}=${value}`);
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.filter(holdsSecret).length).toBe(0);
});

it('finds no key in the environment of any process it can read', () => {
  // Only Linux has this, and that is where the jobs run.
  if (!existsSync('/proc/self/environ')) return;
  let read = 0;
  let found = 0;
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const entries = readFileSync(`/proc/${name}/environ`, 'latin1').split('\0');
      read += 1;
      found += entries.filter(holdsSecret).length;
    } catch {
      // A process can end while this runs, or belong to another user.
    }
  }
  // Reading nothing would look like finding nothing.
  expect(read).toBeGreaterThan(0);
  expect(found).toBe(0);
});
