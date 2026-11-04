// Test output comes from running code on the branch, so it is untrusted. This keeps
// it short and removes what could hide text from a reader or leak a credential.

import { randomBytes } from 'node:crypto';

const ANSI_SEQUENCE = /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\^_])/g;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Zero-width and direction characters can make text read differently than it is.
const INVISIBLE_CHARACTER = /[­​-‏‪-‮⁠-⁩﻿]/g;
export const CREDENTIAL = /\b(?:sk-ant-[\w-]+|gh[pousr]_\w+|github_pat_\w+)/g;

export const DEFAULT_LOG_LIMIT = 4000;
export const DEFAULT_MESSAGE_LIMIT = 1500;

export function clean(text) {
  return String(text ?? '')
    .replace(ANSI_SEQUENCE, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARACTER, '')
    .replace(INVISIBLE_CHARACTER, '')
    .replace(CREDENTIAL, '[REDACTED]');
}

/**
 * Marks text as data for the model. The tag has a random part per run, so the text cannot
 * close it. JSON escapes of control characters are removed too, because a model reads them.
 */
export function wrapUntrusted(label, text, nonce = randomBytes(8).toString('hex')) {
  const tag = `untrusted-${label}-${nonce}`;
  const data = clean(text).replace(/\\u00(?:0[0-8bcefBCEF]|1[0-9a-fA-F]|7[fF])/g, '');
  return `<${tag}>\n${data}\n</${tag}>`;
}

/** For a whole log. Keeps the end, because test runners print failures and summaries last. */
export function sanitizeLog(text, limit = DEFAULT_LOG_LIMIT) {
  const log = clean(text);
  if (log.length <= limit) return log;
  return `[truncated ${log.length - limit} characters]\n${log.slice(-limit)}`;
}

/**
 * For the failure of one test. Keeps the start, because the assertion error comes first
 * and the stack follows. Frames inside dependencies say nothing about the failure.
 */
export function sanitizeFailureMessage(text, limit = DEFAULT_MESSAGE_LIMIT) {
  const message = clean(text)
    .split('\n')
    .filter((line) => !/^\s*at\s.*node_modules\//.test(line))
    .join('\n')
    .trimEnd();
  if (message.length <= limit) return message;
  return `${message.slice(0, limit)}\n[truncated ${message.length - limit} characters]`;
}
