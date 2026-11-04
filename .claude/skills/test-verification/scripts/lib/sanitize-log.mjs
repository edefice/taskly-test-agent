// Test output comes from running code on the branch, so it is untrusted. This keeps
// it short and removes what could hide text from a reader or leak a credential.

const ANSI_SEQUENCE = /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\^_])/g;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const CREDENTIAL = /\b(?:sk-ant-[\w-]+|gh[pousr]_\w+|github_pat_\w+)/g;

export const DEFAULT_LOG_LIMIT = 4000;
export const DEFAULT_MESSAGE_LIMIT = 1500;

function clean(text) {
  return String(text ?? '')
    .replace(ANSI_SEQUENCE, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARACTER, '')
    .replace(CREDENTIAL, '[REDACTED]');
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
