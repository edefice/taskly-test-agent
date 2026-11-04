#!/usr/bin/env node
// Checks the agent's result before anything trusts it. The result never decides what
// gets committed, but a report must not claim things the agent did not do.
//
//   validate-result.mjs --result <file> [--verify <verify report file>]
//
// Exit codes: 0 valid, 1 invalid or missing. Errors never repeat values from the result.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyTestPath } from '../../../lib/test-paths.mjs';

export const AGENT_RESULT_SCHEMA = JSON.parse(readFileSync(new URL('../schema/agent-result.schema.json', import.meta.url), 'utf8'));

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/** Validates the subset of JSON Schema that the agent result schema uses. */
export function validateAgainstSchema(value, schema, path = 'result') {
  if (schema.type && typeOf(value) !== schema.type) return [`${path} must be of type ${schema.type}.`];
  const errors = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} has a value that is not allowed.`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is too short.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength} characters.`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items.`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateAgainstSchema(item, schema.items, `${path}[${index}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is missing.`);
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) errors.push(...validateAgainstSchema(item, properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path} has a property that is not allowed.`);
    }
  }
  return errors;
}

/** Rules that the schema cannot express. Assumes the schema has already passed. */
function checkConsistency(result) {
  const errors = [];
  const paths = new Set(result.files.map(({ path }) => path));
  if (['tests_added', 'tests_updated'].includes(result.decision)) {
    if (result.files.length === 0) errors.push(`The decision ${result.decision} needs at least one file.`);
    if (result.decision === 'tests_added' && result.tests.length === 0) errors.push('The decision tests_added needs at least one described test.');
  }
  if (result.decision === 'no_tests_needed' && (result.files.length > 0 || result.tests.length > 0)) {
    errors.push('The decision no_tests_needed cannot list files or tests.');
  }
  result.files.forEach(({ path }, index) => {
    if (classifyTestPath(path) === null) errors.push(`result.files[${index}].path is outside the test allowlist.`);
  });
  result.tests.forEach(({ file }, index) => {
    if (!paths.has(file)) errors.push(`result.tests[${index}].file is not listed in result.files.`);
  });
  result.existing_tests_changed.forEach(({ path }, index) => {
    if (!paths.has(path)) errors.push(`result.existing_tests_changed[${index}].path is not listed in result.files.`);
  });
  return errors;
}

export function validateResult(result) {
  const schemaErrors = validateAgainstSchema(result, AGENT_RESULT_SCHEMA);
  return schemaErrors.length > 0 ? schemaErrors : checkConsistency(result);
}

const NAME_SEPARATORS = [' › ', ' > ', ' '];
const isFullNameOf = (name, title) => NAME_SEPARATORS.some((separator) => name.endsWith(`${separator}${title}`));

/**
 * Counts new tests with no entry in the result. An entry can use the exact title, or the full
 * name with the describe text in front. A wrong format in metadata is no reason to reject good
 * tests, and it cost a repair round in real runs. A full name counts only when it is
 * unambiguous: one entry fits the title, and that entry fits no other title.
 */
export function countUndescribedTests(newTests, described) {
  let undescribed = 0;
  for (const path of new Set(newTests.map((test) => test.path))) {
    const titles = newTests.filter((test) => test.path === path).map(({ title }) => title);
    const names = new Set(described.filter(({ file }) => file === path).map(({ name }) => name));
    const open = titles.filter((title) => !names.has(title));
    const otherNames = [...names].filter((name) => !titles.includes(name));
    for (const title of open) {
      const candidates = otherNames.filter((name) => isFullNameOf(name, title));
      const clear = candidates.length === 1 && open.filter((other) => isFullNameOf(candidates[0], other)).length === 1;
      if (!clear) undescribed += 1;
    }
  }
  return undescribed;
}

/** Compares what the agent claims with what the gate found in the working tree. */
export function crossCheckWithVerification(result, verification) {
  const errors = [];
  const declared = new Set(result.files.map(({ path }) => path));
  const changed = verification.changed_files ?? [];
  const actual = new Set(changed.map(({ path }) => path));
  let undeclared = 0;
  for (const path of actual) if (!declared.has(path)) undeclared += 1;
  if (undeclared > 0) errors.push(`${undeclared} changed file(s) are not listed in the result.`);
  let invented = 0;
  for (const path of declared) if (!actual.has(path)) invented += 1;
  if (invented > 0) errors.push(`${invented} file(s) in the result did not change.`);
  const described = new Set(result.tests.map(({ file }) => file));
  const justified = new Set(result.existing_tests_changed.map(({ path }) => path));
  const changedExisting = new Set((verification.existing_tests_changed ?? []).map(({ path }) => path));
  // A test file that only changes existing lines is explained by its justification instead.
  const undescribed = changed.filter(({ path, class: kind }) => kind === 'test' && !described.has(path) && !justified.has(path)).length;
  if (undescribed > 0) errors.push(`${undescribed} changed test file(s) have no test described in the result.`);
  // A test that cannot be described in one sentence should not exist, so each one needs its own entry.
  const undescribedTests = countUndescribedTests(verification.new_tests ?? [], result.tests);
  if (undescribedTests > 0) errors.push(`${undescribedTests} new test(s) have no entry in the result with their title.`);
  let unjustified = 0;
  for (const path of changedExisting) if (!justified.has(path)) unjustified += 1;
  if (unjustified > 0) errors.push(`${unjustified} changed existing test file(s) have no justification in the result.`);
  return errors;
}

export function readResultFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { result: null, errors: [`The agent result file does not exist or cannot be read: ${path}`] };
  }
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return { result: null, errors: ['The agent result is not valid JSON.'] };
  }
  return { result, errors: validateResult(result) };
}

function main() {
  const { values } = parseArgs({ options: { result: { type: 'string' }, verify: { type: 'string' } } });
  if (!values.result) throw new Error('Usage: validate-result.mjs --result <file> [--verify <file>]');
  const { result, errors } = readResultFile(values.result);
  if (errors.length === 0 && values.verify) {
    errors.push(...crossCheckWithVerification(result, JSON.parse(readFileSync(values.verify, 'utf8'))));
  }
  if (errors.length > 0) {
    process.stderr.write(`The agent result is not valid:\n${errors.map((error) => `- ${error}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write('The agent result is valid.\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`validate-result: ${error.message}\n`);
    process.exitCode = 1;
  }
}
