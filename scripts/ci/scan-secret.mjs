#!/usr/bin/env node
// Looks for the exact value of the API key in what the agent job is about to publish. An agent
// that read the key could write it into a test or its output, and a public artifact or commit
// would then leak it. It runs before anything leaves the job, and a hit stops the upload.
//
//   ANTHROPIC_API_KEY=... scan-secret.mjs <file or directory>...
//
// Exit codes: 0 clean, 1 found, 2 could not scan. Anything but 0 must stop the upload.
// Step output: result, which is clean, found or error. The report needs the difference, because
// only a hit means the key has to be replaced.
// The output names the file and the encoding, and never the value.
//
// It finds the value as plain text, hex and base64, also inside longer base64 and across line
// breaks. It does not find a value that was split, reversed or compressed. Push protection and
// secret scanning stay as a last layer, and the agent has no Bash and no key in its tools.

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setOutputs } from './lib/github.mjs';

/**
 * The value in each encoding to look for. Base64 of the value inside longer data differs by
 * its position, so there are three forms, without the characters that depend on what is next to it.
 * @returns {{ kind: string, text: string }[]}
 */
export function secretNeedles(secret) {
  const value = Buffer.from(secret, 'utf8');
  const needles = [
    { kind: 'plain text', text: secret },
    { kind: 'hex', text: value.toString('hex') },
    { kind: 'hex', text: value.toString('hex').toUpperCase() },
  ];
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), value]).toString('base64').replace(/=+$/, '');
    const start = Math.ceil((offset * 8) / 6);
    const end = (offset + value.length) % 3 === 0 ? encoded.length : encoded.length - 1;
    const text = encoded.slice(start, end);
    needles.push({ kind: 'base64', text });
    needles.push({ kind: 'base64', text: text.replaceAll('+', '-').replaceAll('/', '_') });
  }
  return needles;
}

/** A line break can split a value, in wrapped base64 or in a string escaped into JSON. */
const withoutLineBreaks = (text) => text.replace(/\\[nr]|\s/g, '');

/** @returns {string | null} The encoding found, or null. */
export function findSecret(content, needles) {
  const text = Buffer.isBuffer(content) ? content.toString('latin1') : String(content);
  const joined = withoutLineBreaks(text);
  for (const { kind, text: needle } of needles) {
    if (text.includes(needle) || joined.includes(needle)) return kind;
  }
  return null;
}

function listFiles(path) {
  const stats = lstatSync(path);
  // Nothing in the output of a run should be a link, and a link could point at anything.
  if (stats.isSymbolicLink()) return [{ path, link: true }];
  if (stats.isDirectory()) return readdirSync(path).sort().flatMap((name) => listFiles(join(path, name)));
  return [{ path, link: false }];
}

/**
 * @param {string[]} paths Files or directories.
 * @param {string} secret The value to look for.
 * @returns {{ path: string, kind: string }[]} Where it was found. Throws if a path cannot be read.
 */
export function scanPaths(paths, secret) {
  if (typeof secret !== 'string' || secret === '') throw new Error('There is no value to look for.');
  const needles = secretNeedles(secret);
  const hits = [];
  for (const { path, link } of paths.flatMap(listFiles)) {
    if (link) {
      hits.push({ path, kind: 'a symbolic link' });
      continue;
    }
    const kind = findSecret(readFileSync(path), needles) ?? findSecret(basename(path), needles);
    if (kind) hits.push({ path, kind });
  }
  return hits;
}

function main(argv, env) {
  if (argv.length === 0) {
    process.stderr.write('Usage: scan-secret.mjs <file or directory>...\n');
    return 2;
  }
  let hits;
  try {
    hits = scanPaths(argv, env.ANTHROPIC_API_KEY);
  } catch (error) {
    // A message from the file system holds a path and no content.
    process.stderr.write(`scan-secret: could not scan: ${error.message}\n`);
    setOutputs({ result: 'error' }, env);
    return 2;
  }
  if (hits.length === 0) {
    process.stdout.write('The output of this run does not contain the API key.\n');
    setOutputs({ result: 'clean' }, env);
    return 0;
  }
  // A hit can be in the name of a file, and the log must not repeat it.
  const needles = secretNeedles(env.ANTHROPIC_API_KEY);
  for (const { path, kind } of hits) {
    const shown = findSecret(path, needles) ? '(a path that holds the value)' : path;
    process.stderr.write(`scan-secret: stopped by ${shown}: ${kind}\n`);
  }
  setOutputs({ result: 'found' }, env);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
