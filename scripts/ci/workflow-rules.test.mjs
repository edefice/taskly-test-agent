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
    runs-on: ubuntu-24.04
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
      - name: Remove instruction files
        run: node "$TOOLS/scripts/ci/remove-instruction-files.mjs"
      - name: Run the agent
        id: agent
        uses: anthropics/claude-code-action@${SHA}
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
          classify_inline_comments: 'false'
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
    runs-on: ubuntu-24.04
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
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - run: echo done
`;
const files = (round = ROUND, caller = CALLER) => ({ 'test-agent-round.yml': round, 'test-agent.yml': caller });
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `the fixture has no: ${from}`);
  return text.replace(from, to);
};
const ACTION_KEY = '          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}\n';
const SCAN_KEY = '        working-directory: ${{ runner.temp }}\n        env:\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n';

describe('parseWorkflow', () => {
  it('reads jobs and steps', () => {
    const { jobs } = parseWorkflow(ROUND);
    assert.deepEqual(jobs.map(({ name }) => name), ['agent', 'verify']);
    assert.equal(jobs[0].steps.length, 7);
    assert.equal(jobs[0].steps[4].uses, `anthropics/claude-code-action@${SHA}`);
    assert.equal(jobs[0].steps[5].id, 'scan');
    assert.deepEqual(jobs[0].steps[5].run, ['node "$TOOLS/scripts/ci/scan-secret.mjs" out']);
  });

  it('reads a script of several lines', () => {
    const { jobs } = parseWorkflow('jobs:\n  a:\n    timeout-minutes: 1\n    steps:\n      - run: |\n          one\n          # a comment\n          two\n');
    assert.deepEqual(jobs[0].steps[0].run, ['one', 'two']);
  });

  it('reads the inputs of a step, and not what is nested in them or follows them', () => {
    const text = 'jobs:\n  a:\n    timeout-minutes: 1\n    steps:\n      - uses: x/y@z\n        with:\n          name: one\n          script: |\n            path: nested\n          # a comment\n        env:\n          pattern: other\n';
    assert.deepEqual(parseWorkflow(text).jobs[0].steps[0].with, { name: 'one', script: '|' });
  });

  it('fails on a file with no jobs, instead of passing it', () => {
    assert.throws(() => parseWorkflow('name: x\n'), /no top-level jobs/);
    assert.throws(() => parseWorkflow('jobs:\n    wrong:\n        indent: true\n'), /expected layout/);
  });
});

describe('checkWorkflow', () => {
  const errorsOf = (text) => checkWorkflow(text, 'f.yml');

  describe('the runner', () => {
    for (const [name, runner] of [['ubuntu-latest', 'ubuntu-latest'], ['another version', 'ubuntu-26.04'], ['a value from a matrix', '${{ matrix.os }}']]) {
      it(`rejects ${name}`, () => {
        assert.match(errorsOf(swap(CALLER, 'runs-on: ubuntu-24.04', `runs-on: ${runner}`)).join('\n'), /Job report does not run on ubuntu-24\.04/);
      });
    }

    it('rejects a job with none', () => {
      assert.match(errorsOf(swap(CALLER, '    runs-on: ubuntu-24.04\n', '')).join('\n'), /Job report does not run on/);
    });

    it('does not ask a call of a reusable workflow for one', () => {
      assert.deepEqual(errorsOf(`permissions: {}\njobs:\n  round:\n    uses: ./.github/workflows/r.yml\n`), []);
    });
  });

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
    ['a secret at the job level', swap(ROUND, '  verify:\n    runs-on: ubuntu-24.04', '  verify:\n    env:\n      K: ${{ secrets.ANTHROPIC_API_KEY }}\n    runs-on: ubuntu-24.04'), /at the job level/],
    ['no timeout', swap(ROUND, '  verify:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n', '  verify:\n    runs-on: ubuntu-24.04\n'), /verify has no timeout-minutes/],
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

  describe('downloads of artifacts', () => {
    const job = (name, inputs, extra = '') => `permissions: {}\njobs:\n  ${name}:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 1\n    steps:\n      - uses: actions/download-artifact@${SHA}\n${extra}        with:\n${inputs.map((line) => `          ${line}\n`).join('')}`;
    const NAMED = ['name: analysis', 'path: ${{ runner.temp }}/artifacts/analysis'];

    it('accepts a download by name to the directory of that name', () => {
      assert.deepEqual(errorsOf(job('verify', NAMED)), []);
    });

    it('accepts a name built from an input, when the path uses the same text', () => {
      assert.deepEqual(errorsOf(job('verify', ['name: gate-round-${{ inputs.previous }}', 'path: ${{ runner.temp }}/artifacts/gate-round-${{ inputs.previous }}'])), []);
    });

    it('allows the report to tolerate a failed download', () => {
      assert.deepEqual(errorsOf(job('report', NAMED, '        continue-on-error: true\n')), []);
    });

    for (const [name, broken, expected] of [
      ['a download with no inputs that name it', job('report', ['path: ${{ runner.temp }}/artifacts']), /has no name/],
      ['a download with no inputs at all', `permissions: {}\njobs:\n  report:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 1\n    steps:\n      - uses: actions/download-artifact@${SHA}\n`, /has no name/],
      ['pattern', job('commit', ['pattern: gate-round-*', 'path: ${{ runner.temp }}/artifacts']), /uses pattern/],
      ['pattern next to a name', job('commit', [...NAMED, 'pattern: gate-round-*']), /uses pattern/],
      ['merge-multiple', job('commit', [...NAMED, 'merge-multiple: true']), /uses merge-multiple/],
      ['artifact-ids', job('commit', ['artifact-ids: 1,2', 'path: ${{ runner.temp }}/artifacts']), /uses artifact-ids/],
      ['a path with no directory for the artifact', job('commit', ['name: analysis', 'path: ${{ runner.temp }}/artifacts']), /must go to .*artifacts\/analysis/],
      ['a path with another name', job('commit', ['name: analysis', 'path: ${{ runner.temp }}/artifacts/baseline']), /must go to .*artifacts\/analysis/],
      ['a path in another directory', job('commit', ['name: analysis', 'path: ${{ runner.temp }}/other/analysis']), /must go to .*artifacts\/analysis/],
      ['no path', job('commit', ['name: analysis']), /must go to .*artifacts\/analysis/],
      ['a tolerated failure outside the report', job('commit', NAMED, '        continue-on-error: true\n'), /only job report may tolerate/],
    ]) {
      it(`rejects ${name}`, () => {
        assert.match(errorsOf(broken).join('\n'), expected);
      });
    }
  });

  describe('automatic caching in setup-node', () => {
    const job = (head, withLines = ['node-version: 24']) => `permissions: {}\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 1\n${head}    steps:\n      - uses: actions/setup-node@${SHA}\n        with:\n${withLines.map((line) => `          ${line}\n`).join('')}`;
    const OFF = ['node-version: 24', 'package-manager-cache: false'];
    const WRITES = (scope) => `    permissions:\n      ${scope}: write\n`;
    const SECRET = '    env:\n      K: x\n    outputs:\n      s: ${{ secrets.K }}\n';

    for (const [name, head] of [['contents', WRITES('contents')], ['pull requests', WRITES('pull-requests')], ['checks', WRITES('checks')]]) {
      it(`rejects it in a job that can write ${name}`, () => {
        assert.match(errorsOf(job(head)).join('\n'), /automatic caching is on/);
      });

      it(`accepts it turned off in a job that can write ${name}`, () => {
        assert.deepEqual(errorsOf(job(head, OFF)), []);
      });
    }

    it('rejects it on, written out, in a job that can write', () => {
      assert.match(errorsOf(job(WRITES('contents'), ['package-manager-cache: true'])).join('\n'), /automatic caching is on/);
    });

    it('looks for a secret in the steps of a job too', () => {
      const text = `permissions: {}\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 1\n    steps:\n      - uses: actions/setup-node@${SHA}\n      - run: echo x\n        env:\n          K: \${{ secrets.K }}\n`;
      assert.match(errorsOf(text).join('\n'), /automatic caching is on/);
    });

    it('leaves a job with no secret and no write access alone, because such a job can run code from the branch', () => {
      assert.deepEqual(errorsOf(job('    permissions:\n      contents: read\n')), []);
    });
  });

  it('allows a checkout with credentials only in a job that writes', () => {
    const job = `jobs:\n  commit:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 1\n    permissions:\n      contents: write\n    steps:\n      - uses: actions/checkout@${SHA}\n`;
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
    ['the key only in the action', swap(ROUND, SCAN_KEY, '        working-directory: ${{ runner.temp }}\n'), /exactly two steps/],
    ['the key in the verify job', swap(ROUND, '      - run: npm ci', '      - run: npm ci\n        env:\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}'), /2 jobs use the key/],
    ['the key under another env name in the scan', swap(ROUND, SCAN_KEY, SCAN_KEY.replace('ANTHROPIC_API_KEY: ${{', 'KEY: ${{')), /one env entry/],
    ['the key in the env of the action, where the steps inside it see it', swap(ROUND, `        with:\n${ACTION_KEY}`, '        env:\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n        with:\n'), /as the input anthropic_api_key/],
    ['the key in both the input and the env of the action', swap(ROUND, `        with:\n${ACTION_KEY}`, `        env:\n          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}\n        with:\n${ACTION_KEY}`), /as the input anthropic_api_key/],
    ['the key as another input of the action', swap(ROUND, ACTION_KEY, '          claude_code_oauth_token: ${{ secrets.ANTHROPIC_API_KEY }}\n'), /as the input anthropic_api_key/],
    ['a second use of the key after the right one', swap(ROUND, ACTION_KEY, `${ACTION_KEY}          claude_code_oauth_token: \${{ secrets.ANTHROPIC_API_KEY }}\n`), /as the input anthropic_api_key/],
    ['a second use of the key in the scan', swap(ROUND, SCAN_KEY, `${SCAN_KEY}          OTHER: \${{ secrets.ANTHROPIC_API_KEY }}\n`), /one env entry/],
    ['another command hidden in an if', swap(ROUND, 'run: mv agent-tools "$RUNNER_TEMP/tools"', 'run: if [ -f package.json ]; then npm ci; fi'), /runs a command it may not/],
    ['another command in place of the sysctl', swap(ROUND, 'run: mv agent-tools "$RUNNER_TEMP/tools"', 'run: if [ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then sudo sh -c "cat /proc/1/environ"; fi'), /runs a command it may not/],
    ['another package in the install', swap(ROUND, 'run: mv agent-tools "$RUNNER_TEMP/tools"', 'run: for i in 1 2 3; do sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends evil && break; echo "apt-get attempt $i failed, retrying..."; sleep 5; done'), /runs a command it may not/],
    ['inline comments on, because that step gets the key', swap(ROUND, "          classify_inline_comments: 'false'\n", ''), /classify_inline_comments off/],
    ['a scan from the checkout of the pull request', swap(ROUND, 'node "$TOOLS/scripts/ci/scan-secret.mjs" out', 'node scripts/ci/scan-secret.mjs out'), /only run the script from the base/],
    ['a scan with more commands', swap(ROUND, 'run: node "$TOOLS/scripts/ci/scan-secret.mjs" out', 'run: |\n          node "$TOOLS/scripts/ci/scan-secret.mjs" out\n          mv out x'), /only run the script from the base/],
    ['a scan that starts in the checkout', swap(ROUND, '        working-directory: ${{ runner.temp }}\n', ''), /outside the checkout/],
    ['npm in the job with the key', swap(ROUND, 'run: node "$TOOLS/scripts/ci/build-agent-prompt.mjs"', 'run: npm ci'), /runs a command it may not: npm ci/],
    ['npx in the job with the key', swap(ROUND, 'run: mv agent-tools "$RUNNER_TEMP/tools"', 'run: npx something'), /runs a command it may not/],
    ['a script from the checkout in the job with the key', swap(ROUND, 'run: node "$TOOLS/scripts/ci/build-agent-prompt.mjs"', 'run: node scripts/ci/build-agent-prompt.mjs'), /runs a command it may not/],
    ['write access in the job with the key', swap(ROUND, '  agent:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    permissions:\n      contents: read', '  agent:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    permissions:\n      contents: write'), /more than read access/],
    ['an OIDC token in the job with the key', swap(ROUND, '  agent:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    permissions:\n      contents: read', '  agent:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    permissions:\n      contents: read\n      id-token: write'), /more than read access/],
    ['a cache in the job with the key', swap(ROUND, `      - name: Keep the tools`, `      - uses: actions/setup-node@${SHA}\n        with:\n          cache: npm\n      - name: Keep the tools`), /restores a cache/],
    ['an upload that ignores the scan', swap(ROUND, "if: ${{ always() && steps.scan.outcome == 'success' }}", 'if: ${{ always() }}'), /does not depend on a clean scan/],
    ['an upload before the scan', swap(swap(ROUND, `      - name: Upload\n        if: \${{ always() && steps.scan.outcome == 'success' }}\n        uses: actions/upload-artifact@${SHA}\n`, ''), '      - name: Scan the output', `      - name: Upload\n        if: \${{ always() && steps.scan.outcome == 'success' }}\n        uses: actions/upload-artifact@${SHA}\n      - name: Scan the output`), /upload runs before the scan/],
    ['another secret', swap(ROUND, '      - run: npm ci', '      - run: echo ${{ secrets.OTHER }}'), /uses the secret OTHER/],
  ]) {
    it(`rejects ${name}`, () => {
      assert.match(errorsOf(round).join('\n'), expected);
    });
  }

  describe('the removal of instruction files', () => {
    const REMOVAL = '      - name: Remove instruction files\n        run: node "$TOOLS/scripts/ci/remove-instruction-files.mjs"\n';
    const errorsWith = (round) => checkSecretIsolation(files(round)).join('\n');
    const withoutRemoval = swap(ROUND, REMOVAL, '');

    for (const [name, broken, expected] of [
      ['no removal', withoutRemoval, /in exactly one step, and it does in 0/],
      ['a removal in two steps', swap(ROUND, REMOVAL, `${REMOVAL}${REMOVAL}`), /in exactly one step, and it does in 2/],
      ['a removal after the action', swap(withoutRemoval, '      - name: Scan the output for the key\n', `${REMOVAL}      - name: Scan the output for the key\n`), /after the action started/],
      ['a removal before the last checkout', swap(withoutRemoval, `      - uses: actions/checkout@${SHA}\n        with:\n          persist-credentials: false\n      - name: Keep`, `${REMOVAL}      - uses: actions/checkout@${SHA}\n        with:\n          persist-credentials: false\n      - name: Keep`), /before the last checkout/],
      ['a failure that does not stop the agent', swap(ROUND, '      - name: Remove instruction files\n', '      - name: Remove instruction files\n        continue-on-error: true\n'), /must always run/],
      ['a removal that can be skipped', swap(ROUND, '      - name: Remove instruction files\n', "      - name: Remove instruction files\n        if: inputs.round == 0\n"), /must always run/],
    ]) {
      it(`rejects ${name}`, () => {
        assert.match(errorsWith(broken), expected);
      });
    }
  });

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

  it('give the agent the baseline, always, and before the step that builds the prompt', () => {
    const { steps } = parseWorkflow(realWorkflows()['test-agent-round.yml']).jobs.find(({ name }) => name === 'agent');
    const download = steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@') && step.with.name === 'baseline');
    const prepare = steps.findIndex(({ id }) => id === 'prepare');
    assert.ok(download !== -1 && download < prepare);
    assert.equal(steps[download].with.path, '${{ runner.temp }}/artifacts/baseline');
    assert.equal(steps[download].continueOnError, undefined);
    assert.doesNotMatch(steps[download].text, /^\s+if:/m);
    assert.doesNotMatch(steps[download].text, /secrets\./);
  });

  it('keep automatic caching off in the jobs of the agent, the commit and the report', () => {
    const steps = (file, jobName) => parseWorkflow(realWorkflows()[file]).jobs.find(({ name }) => name === jobName).steps.filter(({ uses }) => uses?.startsWith('actions/setup-node@'));
    for (const [file, jobName] of [['test-agent-round.yml', 'agent'], ['test-agent.yml', 'commit'], ['test-agent.yml', 'report']]) {
      assert.equal(steps(file, jobName).length, 1, jobName);
      assert.match(steps(file, jobName)[0].text, /package-manager-cache: false/, jobName);
    }
  });

  it('run the agent only on pull requests into main, because the base commit chooses the tools', () => {
    assert.match(realWorkflows()['test-agent.yml'], /^on:\n {2}pull_request:\n(?: +#.*\n)* {4}branches: \[main\]\n/m);
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

  it('install what the isolation needs before the agent, and keep the isolation on', () => {
    const { jobs } = parseWorkflow(realWorkflows()['test-agent-round.yml']);
    const { steps } = jobs.find(({ name }) => name === 'agent');
    const install = steps.findIndex(({ run }) => run?.some((line) => line.includes('bubblewrap')));
    const agent = steps.findIndex(({ id }) => id === 'agent');
    assert.ok(install !== -1 && install < agent);
    assert.ok(!/secrets\./.test(steps[install].text), 'the install step has no key');
    assert.match(steps[agent].text, /CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'/);
  });

  it('tell the report how the agent step ended, from a value that exists when it fails', () => {
    const { jobs } = parseWorkflow(realWorkflows()['test-agent-round.yml']);
    const collect = jobs.find(({ name }) => name === 'agent').steps.find(({ name }) => name === 'Collect what the agent did');
    assert.match(collect.text, /AGENT_OUTCOME: \$\{\{ steps\.agent\.outcome \}\}/);
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

  describe('downloads', () => {
    const downloadsOf = (jobName) => parseWorkflow(realWorkflows()['test-agent.yml']).jobs.find(({ name }) => name === jobName).steps.filter(({ uses }) => uses?.startsWith('actions/download-artifact@'));
    const conditionOf = (step) => step.lines.find((line) => line.trim().startsWith('if:'))?.trim().slice(4);

    it('give the commit job only accepted rounds, and let it fail when one is missing', () => {
      const steps = downloadsOf('commit');
      assert.deepEqual(steps.map((step) => step.with.name), ['gate-round-0', 'gate-round-1', 'gate-round-2']);
      assert.deepEqual(steps.map(conditionOf), [0, 1, 2].map((round) => `needs.round-${round}.outputs.accepted == 'true'`));
    });

    it('start the commit job after an accepted attempt in any round, and not after the scan found the key in any', () => {
      const head = parseWorkflow(realWorkflows()['test-agent.yml']).jobs.find(({ name }) => name === 'commit').head.join('\n');
      for (const round of [0, 1, 2]) {
        assert.ok(head.includes(`needs.round-${round}.outputs.accepted == 'true'`), `accepted in round ${round}`);
        assert.ok(head.includes(`needs.round-${round}.outputs.scan != 'found'`), `scan in round ${round}`);
      }
    });

    it('give the report what it reads, each only when its job can have left it, and a failure does not stop the report', () => {
      const steps = downloadsOf('report');
      assert.deepEqual(Object.fromEntries(steps.map((step) => [step.with.name, conditionOf(step)])), {
        analysis: "needs.analyze.outputs.report != ''",
        baseline: "needs.baseline.result == 'success'",
        'gate-round-0': "needs.round-0.outputs.scan == 'clean'",
        'gate-round-1': "needs.round-1.outputs.scan == 'clean'",
        'gate-round-2': "needs.round-2.outputs.scan == 'clean'",
        commit: "needs.commit.result == 'success'",
      });
      for (const step of steps) assert.equal(step.continueOnError, 'true', step.with.name);
    });
  });

  it('take the patch to commit from a job with no secret, and check out no code to run in the commit job', () => {
    const { jobs } = parseWorkflow(realWorkflows()['test-agent.yml']);
    const commit = jobs.find(({ name }) => name === 'commit');
    assert.doesNotMatch(commit.jobText, /npm |npx |secrets\./);
    assert.match(commit.jobText, /needs\.round-0\.outputs\.scan != 'found'/);
  });
});
