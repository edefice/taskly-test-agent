import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { checkSecretIsolation, checkWorkflow, parseWorkflow } from './workflow-rules.mjs';

const WORKFLOWS = new URL('../../.github/workflows/', import.meta.url);
const realWorkflows = () => Object.fromEntries(readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml')).map((name) => [name, readFileSync(new URL(name, WORKFLOWS), 'utf8')]));

const SHA = 'a'.repeat(40);

// A small workflow with the shape the rules protect. Each test below breaks one thing in it.
const ROUND = `name: Round
on:
  workflow_call:
    secrets:
      ANTHROPIC_API_KEY:
        required: true
permissions: {}
jobs:
  agent:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
      - name: Keep the tools out of the checkout
        run: mv agent-tools "$RUNNER_TEMP/tools"
      - name: Build the prompt
        id: prompt
        run: node "$TOOLS/scripts/ci/build-agent-prompt.mjs"
      - name: Run the agent
        id: agent
        uses: anthropics/claude-code-action@${SHA}
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
      - name: Scan the output for the key
        id: scan
        working-directory: \${{ runner.temp }}
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: node "$TOOLS/scripts/ci/scan-secret.mjs" out
      - name: Upload
        if: \${{ always() && steps.scan.outcome == 'success' }}
        uses: actions/upload-artifact@${SHA}
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
      - run: npm ci
`;
const CALLER = `name: Agent
on:
  pull_request:
permissions: {}
jobs:
  round:
    uses: ./.github/workflows/test-agent-round.yml
    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
  report:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo done
`;
const files = (round = ROUND, caller = CALLER) => ({ 'test-agent-round.yml': round, 'test-agent.yml': caller });
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `the fixture has no: ${from}`);
  return text.replace(from, to);
};
const ACTION_KEY = `uses: anthropics/claude-code-action@${SHA}\n        env:\n          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}`;

describe('parseWorkflow', () => {
  it('reads jobs and steps', () => {
    const { jobs } = parseWorkflow(ROUND);
    assert.deepEqual(jobs.map(({ name }) => name), ['agent', 'verify']);
    assert.equal(jobs[0].steps.length, 6);
    assert.equal(jobs[0].steps[3].uses, `anthropics/claude-code-action@${SHA}`);
    assert.equal(jobs[0].steps[4].id, 'scan');
    assert.deepEqual(jobs[0].steps[4].run, ['node "$TOOLS/scripts/ci/scan-secret.mjs" out']);
  });

  it('reads a script of several lines', () => {
    const { jobs } = parseWorkflow('jobs:\n  a:\n    timeout-minutes: 1\n    steps:\n      - run: |\n          one\n          # a comment\n          two\n');
    assert.deepEqual(jobs[0].steps[0].run, ['one', 'two']);
  });

  it('fails on a file with no jobs, instead of passing it', () => {
    assert.throws(() => parseWorkflow('name: x\n'), /no top-level jobs/);
    assert.throws(() => parseWorkflow('jobs:\n    wrong:\n        indent: true\n'), /expected layout/);
  });
});

describe('checkWorkflow', () => {
  const errorsOf = (text) => checkWorkflow(text, 'f.yml');

  it('accepts the shape above', () => {
    assert.deepEqual(errorsOf(ROUND), []);
    assert.deepEqual(errorsOf(CALLER), []);
  });

  for (const [name, broken, expected] of [
    ['pull_request_target', swap(CALLER, 'pull_request:', 'pull_request_target:'), /trigger that runs with secrets/],
    ['workflow_run', swap(CALLER, 'pull_request:', 'workflow_run:'), /trigger that runs with secrets/],
    ['no top-level permissions', swap(CALLER, 'permissions: {}\n', ''), /no top-level permissions/],
    ['write-all', swap(CALLER, 'permissions: {}', 'permissions: write-all'), /write-all/],
    ['secrets inherit', swap(CALLER, 'secrets:\n      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}', 'secrets: inherit'), /inherit/],
    ['a secret at the top level', swap(CALLER, 'jobs:', 'env:\n  K: ${{ secrets.ANTHROPIC_API_KEY }}\njobs:'), /at the top level/],
    ['a secret at the job level', swap(ROUND, '  verify:\n    runs-on: ubuntu-latest', '  verify:\n    env:\n      K: ${{ secrets.ANTHROPIC_API_KEY }}\n    runs-on: ubuntu-latest'), /at the job level/],
    ['no timeout', swap(ROUND, '  verify:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n', '  verify:\n    runs-on: ubuntu-latest\n'), /verify has no timeout-minutes/],
    ['an action on a tag', swap(ROUND, `actions/upload-artifact@${SHA}`, 'actions/upload-artifact@v7'), /not pinned/],
    ['an action on a short SHA', swap(ROUND, `actions/upload-artifact@${SHA}`, 'actions/upload-artifact@abc1234'), /not pinned/],
    ['a checkout that keeps credentials', swap(ROUND, `actions/checkout@${SHA}\n        with:\n          persist-credentials: false\n      - name: Keep`, `actions/checkout@${SHA}\n      - name: Keep`), /keeps its credentials/],
    ['text from the event in a script', swap(CALLER, 'echo done', 'echo ${{ github.event.pull_request.title }}'), /expands text from the event/],
    ['the branch name in a script', swap(CALLER, 'echo done', 'echo ${{ github.head_ref }}'), /expands text from the event/],
    ['an input in a script', swap(CALLER, 'echo done', 'echo ${{ inputs.feedback }}'), /expands text from the event/],
  ]) {
    it(`rejects ${name}`, () => {
      assert.match(errorsOf(broken).join('\n'), expected);
    });
  }

  it('allows a checkout with credentials only in a job that writes', () => {
    const job = `jobs:\n  commit:\n    timeout-minutes: 1\n    permissions:\n      contents: write\n    steps:\n      - uses: actions/checkout@${SHA}\n`;
    assert.deepEqual(errorsOf(`permissions: {}\n${job}`), []);
  });

  it('reports a file it cannot read as an error', () => {
    assert.match(errorsOf('name: x\n').join(), /no top-level jobs/);
  });
});

describe('checkSecretIsolation', () => {
  const errorsOf = (round, caller) => checkSecretIsolation(files(round, caller));

  it('accepts the shape above', () => {
    assert.deepEqual(errorsOf(), []);
  });

  it('fails when the file it protects is missing', () => {
    assert.match(checkSecretIsolation({ 'test-agent.yml': CALLER }).join(), /test-agent-round\.yml is missing/);
  });

  for (const [name, round, expected] of [
    ['a third step with the key', swap(ROUND, '      - name: Build the prompt\n        id: prompt\n', '      - name: Build the prompt\n        id: prompt\n        env:\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n'), /exactly two steps/],
    ['the key only in the action', swap(ROUND, '        working-directory: ${{ runner.temp }}\n        env:\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n', '        working-directory: ${{ runner.temp }}\n'), /exactly two steps/],
    ['the key in the verify job', swap(ROUND, '      - run: npm ci', '      - run: npm ci\n        env:\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}'), /2 jobs use the key/],
    ['the key under another env name', swap(ROUND, ACTION_KEY, ACTION_KEY.replace('ANTHROPIC_API_KEY: ${{', 'KEY: ${{')), /one env entry/],
    ['the key in a with block', swap(ROUND, ACTION_KEY, `uses: anthropics/claude-code-action@${SHA}\n        with:\n          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}`), /one env entry/],
    ['a scan from the checkout of the pull request', swap(ROUND, 'node "$TOOLS/scripts/ci/scan-secret.mjs" out', 'node scripts/ci/scan-secret.mjs out'), /only run the script from the base/],
    ['a scan with more commands', swap(ROUND, 'run: node "$TOOLS/scripts/ci/scan-secret.mjs" out', 'run: |\n          node "$TOOLS/scripts/ci/scan-secret.mjs" out\n          mv out x'), /only run the script from the base/],
    ['a scan that starts in the checkout', swap(ROUND, '        working-directory: ${{ runner.temp }}\n', ''), /outside the checkout/],
    ['npm in the job with the key', swap(ROUND, 'run: node "$TOOLS/scripts/ci/build-agent-prompt.mjs"', 'run: npm ci'), /runs a command it may not: npm ci/],
    ['npx in the job with the key', swap(ROUND, 'run: mv agent-tools "$RUNNER_TEMP/tools"', 'run: npx something'), /runs a command it may not/],
    ['a script from the checkout in the job with the key', swap(ROUND, 'run: node "$TOOLS/scripts/ci/build-agent-prompt.mjs"', 'run: node scripts/ci/build-agent-prompt.mjs'), /runs a command it may not/],
    ['write access in the job with the key', swap(ROUND, '  agent:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    permissions:\n      contents: read', '  agent:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    permissions:\n      contents: write'), /more than read access/],
    ['an OIDC token in the job with the key', swap(ROUND, '  agent:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    permissions:\n      contents: read', '  agent:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    permissions:\n      contents: read\n      id-token: write'), /more than read access/],
    ['a cache in the job with the key', swap(ROUND, `      - name: Keep the tools`, `      - uses: actions/setup-node@${SHA}\n        with:\n          cache: npm\n      - name: Keep the tools`), /restores a cache/],
    ['an upload that ignores the scan', swap(ROUND, "if: ${{ always() && steps.scan.outcome == 'success' }}", 'if: ${{ always() }}'), /does not depend on a clean scan/],
    ['an upload before the scan', swap(swap(ROUND, `      - name: Upload\n        if: \${{ always() && steps.scan.outcome == 'success' }}\n        uses: actions/upload-artifact@${SHA}\n`, ''), '      - name: Scan the output', `      - name: Upload\n        if: \${{ always() && steps.scan.outcome == 'success' }}\n        uses: actions/upload-artifact@${SHA}\n      - name: Scan the output`), /upload runs before the scan/],
    ['another secret', swap(ROUND, '      - run: npm ci', '      - run: echo ${{ secrets.OTHER }}'), /uses the secret OTHER/],
  ]) {
    it(`rejects ${name}`, () => {
      assert.match(errorsOf(round).join('\n'), expected);
    });
  }

  it('rejects the key in a job of the caller that is not the call', () => {
    const caller = swap(CALLER, '      - run: echo done', '      - run: echo done\n        env:\n          K: ${{ secrets.ANTHROPIC_API_KEY }}');
    assert.match(errorsOf(ROUND, caller).join('\n'), /job report uses a secret and is not the call/);
  });
});

describe('the workflows in this repository', () => {
  it('follow the rules for every workflow', () => {
    const errors = Object.entries(realWorkflows()).flatMap(([file, text]) => checkWorkflow(text, file));
    assert.deepEqual(errors, []);
  });

  it('keep the key in two steps of one job, and no code from a pull request runs there', () => {
    assert.deepEqual(checkSecretIsolation(realWorkflows()), []);
  });

  it('have the key in two steps and in nothing else, by a plain count', () => {
    const files = realWorkflows();
    const count = (file) => (files[file].match(/secrets\.ANTHROPIC_API_KEY/g) ?? []).length;
    assert.equal(count('test-agent-round.yml'), 2);
    assert.equal(count('test-agent.yml'), 3, 'one passed value for each of the three rounds');
    assert.equal(count('ci.yml'), 0);
  });

  it('give the gate the history it compares with', () => {
    const { jobs } = parseWorkflow(realWorkflows()['test-agent-round.yml']);
    const [checkout] = jobs.find(({ name }) => name === 'verify').steps;
    assert.match(checkout.text, /fetch-depth: 0/);
    assert.match(checkout.text, /head\.sha/);
  });

  it('hold no other secret at all', () => {
    for (const [file, text] of Object.entries(realWorkflows())) {
      const names = [...text.matchAll(/secrets\.(\w+)/g)].map(([, name]) => name);
      assert.deepEqual(names.filter((name) => name !== 'ANTHROPIC_API_KEY'), [], file);
    }
  });

  it('run the agent without Bash, through the arguments the tests cover', () => {
    const { jobs } = parseWorkflow(realWorkflows()['test-agent-round.yml']);
    const agent = jobs.find(({ name }) => name === 'agent').steps.find(({ id }) => id === 'agent');
    assert.match(agent.text, /claude_args: \$\{\{ steps\.prepare\.outputs\.claude_args \}\}/);
    assert.match(agent.text, /UNIT_TEST_AGENT_ENFORCE: '1'/);
    assert.match(agent.text, /classify_inline_comments: 'false'/);
    assert.doesNotMatch(agent.text, /show_full_output|allowed_non_write_users|allowed_bots/);
  });

  it('give write access to the commit job only, and the report what it posts', () => {
    const writes = {};
    for (const [file, text] of Object.entries(realWorkflows())) {
      for (const job of parseWorkflow(text).jobs) {
        const granted = job.head.filter((line) => /: write\s*$/.test(line)).map((line) => line.trim());
        if (granted.length > 0) writes[`${file}/${job.name}`] = granted;
      }
    }
    assert.deepEqual(writes, { 'test-agent.yml/commit': ['contents: write'], 'test-agent.yml/report': ['pull-requests: write', 'checks: write'] });
  });

  it('take the patch to commit from a job with no secret, and check out no code to run in the commit job', () => {
    const { jobs } = parseWorkflow(realWorkflows()['test-agent.yml']);
    const commit = jobs.find(({ name }) => name === 'commit');
    assert.doesNotMatch(commit.jobText, /npm |npx |secrets\./);
    assert.match(commit.jobText, /needs\.round-0\.outputs\.scan != 'found'/);
  });
});
