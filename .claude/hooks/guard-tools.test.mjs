import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE_CLAUDE_DIR = fileURLToPath(new URL('..', import.meta.url));
const AGENT = 'unit-test-agent';

let sandbox;
let repo;
let outside;

// The hook takes the repository root from its own location, so each test run
// gets a copy of it inside a throwaway repository with real files and links.
before(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'guard-tools-')));
  repo = join(sandbox, 'repo');
  outside = join(sandbox, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  for (const dir of ['hooks', 'lib']) {
    cpSync(join(SOURCE_CLAUDE_DIR, dir), join(repo, '.claude', dir), { recursive: true });
  }
  for (const dir of ['backend/src', 'backend/tests', 'frontend/src/lib', 'frontend/src/test', '.git', '.claude-pr']) {
    mkdirSync(join(repo, dir), { recursive: true });
  }
  writeFileSync(join(repo, 'backend/src/app.ts'), 'export {};');
  writeFileSync(join(repo, 'backend/tests/fixture.ts'), 'export {};');
  writeFileSync(join(repo, '.env'), 'SECRET=1');
  writeFileSync(join(repo, '.git/config'), '');

  // Links with names that pass the allowlist but lead somewhere they must not.
  symlinkSync(join(outside, 'secret.txt'), join(repo, 'backend/tests/outside.test.ts'));
  symlinkSync(outside, join(repo, 'backend/tests/outside-dir'));
  symlinkSync(join(repo, 'backend/src/app.ts'), join(repo, 'backend/tests/app.test.ts'));
  symlinkSync(join(repo, 'backend/src'), join(repo, 'backend/tests/src-dir'));
  symlinkSync(join(repo, '.env'), join(repo, 'backend/tests/env-link'));
  symlinkSync(join(repo, 'nowhere.ts'), join(repo, 'backend/tests/dangling.test.ts'));
  symlinkSync(join(outside, 'not-yet.txt'), join(repo, 'backend/tests/dangling-outside.test.ts'));
  symlinkSync(join(repo, 'backend/tests/fixture.ts'), join(repo, 'backend/tests/fixture-link.ts'));
  // A pull request can commit a link like this. Dangling on macOS, real on Linux.
  symlinkSync('/proc/self/environ', join(repo, 'backend/tests/environ.test.ts'));
  symlinkSync('/proc/self', join(repo, 'backend/tests/proc-self'));
  symlinkSync(join(homedir(), '.claude'), join(repo, 'backend/tests/claude-home'));
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

function runHook(input, env = {}) {
  const { [`UNIT_TEST_AGENT_ENFORCE`]: _ignored, ...baseEnv } = process.env;
  return spawnSync(process.execPath, [join(repo, '.claude/hooks/guard-tools.mjs')], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...baseEnv, ...env },
  });
}

function agentCall(tool, toolInput, extra = {}) {
  return runHook({ agent_type: AGENT, cwd: repo, tool_name: tool, tool_input: toolInput, ...extra });
}

function assertAllowed(result) {
  assert.equal(result.status, 0, `expected allow, got: ${result.stderr}`);
  assert.equal(result.stdout, '', 'an allow must print nothing, so it is not read as an approval');
}

function assertDenied(result, pattern) {
  assert.equal(result.status, 2, 'expected the hook to block with exit code 2');
  assert.notEqual(result.stderr.trim(), '', 'a block must tell the model why');
  if (pattern) assert.match(result.stderr, pattern);
}

describe('agent: writing files', () => {
  for (const tool of ['Write', 'Edit']) {
    it(`${tool} may change a test file`, () => {
      assertAllowed(agentCall(tool, { file_path: join(repo, 'backend/tests/new.test.ts') }));
    });

    it(`${tool} may change a test file through a relative path`, () => {
      assertAllowed(agentCall(tool, { file_path: 'frontend/src/lib/http.test.ts' }));
    });

    it(`${tool} may change shared test support`, () => {
      assertAllowed(agentCall(tool, { file_path: join(repo, 'frontend/src/design-system/mocks.tsx') }));
    });

    it(`${tool} may not change application code`, () => {
      assertDenied(agentCall(tool, { file_path: join(repo, 'backend/src/app.ts') }), /not allowed/);
    });

    for (const path of ['package.json', '.claude/settings.json', '.github/workflows/ci.yml', 'CLAUDE.md']) {
      it(`${tool} may not change ${path}`, () => {
        assertDenied(agentCall(tool, { file_path: join(repo, path) }));
      });
    }

    it(`${tool} may not leave the repository through ..`, () => {
      assertDenied(agentCall(tool, { file_path: join(repo, 'backend/tests/../src/app.ts') }));
      assertDenied(agentCall(tool, { file_path: 'backend/tests/../../../outside/a.test.ts' }));
    });

    it(`${tool} may not write outside the repository`, () => {
      assertDenied(agentCall(tool, { file_path: join(outside, 'a.test.ts') }), /outside the repository/);
    });

    it(`${tool} may not write through a link with an allowed name that leaves the repository`, () => {
      assertDenied(agentCall(tool, { file_path: join(repo, 'backend/tests/outside.test.ts') }), /outside the repository/);
    });

    it(`${tool} may not write into a linked directory that leaves the repository`, () => {
      assertDenied(agentCall(tool, { file_path: join(repo, 'backend/tests/outside-dir/a.test.ts') }));
    });

    it(`${tool} may not write through a link with an allowed name to application code`, () => {
      assertDenied(agentCall(tool, { file_path: join(repo, 'backend/tests/app.test.ts') }));
    });

    it(`${tool} may not write into a linked directory that holds application code`, () => {
      assertDenied(agentCall(tool, { file_path: join(repo, 'backend/tests/src-dir/a.test.ts') }));
    });

    it(`${tool} may not write through a dangling link`, () => {
      assertDenied(agentCall(tool, { file_path: join(repo, 'backend/tests/dangling.test.ts') }));
      assertDenied(agentCall(tool, { file_path: join(repo, 'backend/tests/dangling-outside.test.ts') }));
    });

    it(`${tool} without a path is blocked`, () => {
      assertDenied(agentCall(tool, {}));
      assertDenied(agentCall(tool, { file_path: 42 }));
      assertDenied(agentCall(tool, { file_path: '' }));
    });
  }

  it('a link that stays inside the allowlist is allowed', () => {
    assertAllowed(agentCall('Write', { file_path: join(repo, 'backend/tests/fixture-link.ts') }));
  });
});

describe('agent: reading files', () => {
  it('may read application code and tests', () => {
    assertAllowed(agentCall('Read', { file_path: join(repo, 'backend/src/app.ts') }));
    assertAllowed(agentCall('Read', { file_path: 'backend/tests/fixture.ts' }));
  });

  it('may read its own skills', () => {
    assertAllowed(agentCall('Read', { file_path: join(repo, '.claude/skills/pr-report/SKILL.md') }));
  });

  // In CI the API key is in the process environment, so these are what keep it from the model.
  for (const path of [
    '/proc/self/environ',
    '/proc/1/environ',
    '/proc/12345/environ',
    '/proc/*/environ',
    '/proc/self/cwd/../environ',
    '/proc/self/root/etc/passwd',
    '/etc/hosts',
    '/etc/passwd',
    '../../../../proc/self/environ',
  ]) {
    it(`may not read ${path}`, () => {
      assertDenied(agentCall('Read', { file_path: path }));
    });
  }

  it('may not read /proc/self/environ when the working directory is unusual', () => {
    assertDenied(agentCall('Read', { file_path: 'environ' }, { cwd: '/proc/self' }));
  });

  it('may not read through a Claude Code configuration path', () => {
    assertDenied(agentCall('Read', { file_path: '~/.claude/settings.json' }), /shell expansion/);
    assertDenied(agentCall('Read', { file_path: '~/.claude.json' }), /shell expansion/);
    assertDenied(agentCall('Read', { file_path: join(homedir(), '.claude/settings.json') }));
    assertDenied(agentCall('Read', { file_path: join(homedir(), '.claude.json') }));
    assertDenied(agentCall('Read', { file_path: '$HOME/.claude/settings.json' }), /shell expansion/);
    assertDenied(agentCall('Read', { file_path: '${HOME}/.ssh/id_rsa' }), /shell expansion/);
  });

  it('may not read through a link that leaves the repository', () => {
    assertDenied(agentCall('Read', { file_path: join(repo, 'backend/tests/outside.test.ts') }));
    assertDenied(agentCall('Read', { file_path: join(repo, 'backend/tests/outside-dir/secret.txt') }));
  });

  it('may not read the process environment through a link committed to the repository', () => {
    assertDenied(agentCall('Read', { file_path: join(repo, 'backend/tests/environ.test.ts') }));
    assertDenied(agentCall('Read', { file_path: join(repo, 'backend/tests/proc-self/environ') }));
  });

  it('may not read the Claude Code home through a link committed to the repository', () => {
    assertDenied(agentCall('Read', { file_path: join(repo, 'backend/tests/claude-home/settings.json') }));
    assertDenied(agentCall('Grep', { pattern: 'KEY', path: join(repo, 'backend/tests/claude-home') }));
  });

  it('may not write the process environment link', () => {
    assertDenied(agentCall('Write', { file_path: join(repo, 'backend/tests/environ.test.ts') }));
  });

  it('may not read a secret through a link inside the repository', () => {
    assertDenied(agentCall('Read', { file_path: join(repo, 'backend/tests/env-link') }));
  });

  for (const path of ['.env', '.env.local', 'backend/.env', 'frontend/.env.production', '.npmrc', '.git/config', '.claude-pr/settings.json', '.test-agent/result.json']) {
    it(`may not read ${path}`, () => {
      assertDenied(agentCall('Read', { file_path: join(repo, path) }));
    });
  }
});

describe('agent: searching', () => {
  it('may search the repository', () => {
    assertAllowed(agentCall('Grep', { pattern: 'createTodosRouter' }));
    assertAllowed(agentCall('Grep', { pattern: 'x', path: 'backend/src', glob: '**/*.ts' }));
    assertAllowed(agentCall('Glob', { pattern: 'backend/tests/**/*.test.ts' }));
    assertAllowed(agentCall('Glob', { pattern: '*.ts', path: join(repo, 'backend/src') }));
  });

  for (const path of ['/proc/self/environ', '/proc', '/etc', '..', '~/.claude', '$HOME', '.git', '.env']) {
    it(`Grep may not search ${path}`, () => {
      assertDenied(agentCall('Grep', { pattern: 'KEY', path }));
    });

    it(`Glob may not search ${path}`, () => {
      assertDenied(agentCall('Glob', { pattern: '*', path }));
    });
  }

  for (const pattern of ['/proc/*/environ', '/proc/self/*', '../../**', 'backend/../../**', '~/.claude/**', '$HOME/**']) {
    it(`Glob may not use the pattern ${pattern}`, () => {
      assertDenied(agentCall('Glob', { pattern }), /outside the repository/);
    });

    it(`Grep may not use the glob ${pattern}`, () => {
      assertDenied(agentCall('Grep', { pattern: 'KEY', glob: pattern }), /outside the repository/);
    });
  }

  for (const pattern of ['.env', '.env.staging', '.?nv', '**/.env*', '.env.*', 'backend/.env', '**/.e*', '.*', '*env', '?env', '[.]env', '**/{.env,*.ts}', '{.npmrc,a}', '**/.npmrc', '.git/config', '**/.git/**', '.claude-pr/**', '.test-agent/*']) {
    it(`Glob may not use the pattern ${pattern}, which can match an unreadable file`, () => {
      assertDenied(agentCall('Glob', { pattern }), /not readable/);
    });

    it(`Grep may not use the glob ${pattern}, which can match an unreadable file`, () => {
      assertDenied(agentCall('Grep', { pattern: 'KEY', glob: pattern }), /not readable/);
    });
  }

  for (const pattern of ['*', '**', '**/*', '**/*.ts', '*.test.tsx', 'backend/**/*.ts', 'frontend/src/*', '**/*.{ts,tsx}', 'environment.ts', '**/env/**', '**/git/*.ts', 'src/[a-z]*.ts', '.npmr.', 'a(b.ts']) {
    it(`Glob may use the pattern ${pattern}`, () => {
      assertAllowed(agentCall('Glob', { pattern }));
    });

    it(`Grep may use the glob ${pattern}`, () => {
      assertAllowed(agentCall('Grep', { pattern: 'x', glob: pattern }));
    });
  }

  it('Glob without a pattern is blocked', () => {
    assertDenied(agentCall('Glob', {}));
  });
});

describe('agent: Bash', () => {
  for (const command of [
    'npm --prefix backend run test',
    'npm --prefix frontend run test',
    'npm --prefix backend run typecheck',
    'npm --prefix frontend run typecheck',
    'npm --prefix frontend run format:check',
    'npm --prefix backend run test:coverage',
    'npm --prefix backend run test -- tests/router.test.ts',
    'npm --prefix frontend run test -- src/lib/http.test.ts --reporter=verbose',
    'npm --prefix backend run test:coverage -- --coverage.include=src/api/health.ts',
    'npm --prefix frontend run test -- --coverage --reporter=json',
  ]) {
    it(`may run: ${command}`, () => {
      assertAllowed(agentCall('Bash', { command }));
    });
  }

  for (const command of [
    // Version control and network.
    'git status',
    'git commit -m x',
    'git push origin main',
    'gh pr create',
    'curl https://example.com',
    'wget https://example.com',
    // Reading the environment.
    'env',
    'printenv ANTHROPIC_API_KEY',
    'cat /proc/self/environ',
    'node -e "console.log(process.env)"',
    // Chaining after an allowed command.
    'npm --prefix backend run test && git push',
    'npm --prefix backend run test; env',
    'npm --prefix backend run test | tee out.txt',
    'npm --prefix backend run test > backend/src/app.ts',
    'npm --prefix backend run test\ncurl example.com',
    'npm --prefix backend run test $(env)',
    'npm --prefix backend run test `env`',
    'FOO=bar npm --prefix backend run test',
    // Other scripts and packages.
    'npm --prefix backend run build',
    'npm --prefix backend run db:studio',
    'npm --prefix backend run dev',
    'npm --prefix backend install',
    'npm --prefix /tmp/evil run test',
    'npm --prefix ../other run test',
    'npm install left-pad',
    'npx vitest run',
    'npm --prefix backend run format:check',
    // Vitest options that load code or write files.
    'npm --prefix backend run test -- --config=/tmp/evil.ts',
    'npm --prefix backend run test -- --config /tmp/evil.ts',
    'npm --prefix backend run test -- --root=/tmp',
    'npm --prefix backend run test -- --dir=/tmp',
    'npm --prefix backend run test -- --reporter=./evil.js',
    'npm --prefix backend run test -- --reporter=/tmp/evil.js',
    'npm --prefix backend run test -- --globalSetup=/tmp/evil.js',
    'npm --prefix backend run test -- --outputFile=backend/src/app.ts',
    'npm --prefix backend run test -- ../../etc/passwd',
    'npm --prefix backend run test -- /etc/passwd',
    'npm --prefix backend run test -- --coverage.include=/etc/passwd',
    // Arguments on scripts that take none.
    'npm --prefix backend run typecheck -- --project /tmp/evil.json',
    'npm --prefix frontend run format:check -- --write',
  ]) {
    it(`may not run: ${JSON.stringify(command)}`, () => {
      assertDenied(agentCall('Bash', { command }));
    });
  }

  it('without a command is blocked', () => {
    assertDenied(agentCall('Bash', {}));
  });
});

describe('agent: other tools', () => {
  for (const skill of ['pr-change-analysis', 'backend-unit-tests', 'frontend-unit-tests', 'test-verification', 'pr-report']) {
    it(`may load the skill ${skill}`, () => {
      assertAllowed(agentCall('Skill', { skill }));
    });
  }

  it('may not load another skill', () => {
    assertDenied(agentCall('Skill', { skill: 'vercel:deploy' }));
    assertDenied(agentCall('Skill', {}));
  });

  it('may return structured output', () => {
    assertAllowed(agentCall('StructuredOutput', { decision: 'no_tests_needed' }));
  });

  for (const tool of ['WebFetch', 'WebSearch', 'Agent', 'NotebookEdit', 'PowerShell', 'mcp__github__create_pull_request', 'SomeFutureTool']) {
    it(`may not use ${tool}`, () => {
      assertDenied(agentCall(tool, {}), /not available/);
    });
  }
});

describe('which sessions are strict', () => {
  const applicationWrite = () => ({ cwd: repo, tool_name: 'Write', tool_input: { file_path: join(repo, 'backend/src/app.ts') } });

  it('a normal session may write anywhere', () => {
    assertAllowed(runHook(applicationWrite()));
  });

  it('another agent is not restricted', () => {
    assertAllowed(runHook({ ...applicationWrite(), agent_type: 'Explore' }));
  });

  it('the agent is restricted by its name', () => {
    assertDenied(runHook({ ...applicationWrite(), agent_type: AGENT }));
  });

  it('the environment switch restricts a session that reports no agent', () => {
    assertDenied(runHook(applicationWrite(), { UNIT_TEST_AGENT_ENFORCE: '1' }));
    assertDenied(runHook({ ...applicationWrite(), agent_type: 'Explore' }, { UNIT_TEST_AGENT_ENFORCE: '1' }));
  });

  it('the environment switch counts only with the exact value', () => {
    assertAllowed(runHook(applicationWrite(), { UNIT_TEST_AGENT_ENFORCE: '0' }));
  });
});

describe('every session: git and gh', () => {
  const bash = (command) => runHook({ cwd: repo, tool_name: 'Bash', tool_input: { command } });

  for (const command of [
    'git status',
    'git status --short --branch',
    'git diff HEAD~1',
    'git diff -- backend/src',
    'git log --oneline -5',
    'git log --grep push',
    'git show HEAD:package.json',
    'git -C backend status',
    'git --no-pager log -1',
    'git rev-parse HEAD',
    'git merge-base main HEAD',
    'git ls-files',
    'git branch',
    'git branch -a -vv',
    'git branch --show-current',
    'git remote -v',
    'git remote get-url origin',
    'git config --get user.name',
    'cd backend && git status',
    'git status | head -5',
    'gh pr view 1',
    'gh pr list',
    'gh run view 123 --log',
    'gh run list --limit 5',
    'gh api repos/o/r/branches/main',
    'gh api repos/o/r --jq .name',
    'gh api -X GET repos/o/r',
    'gh api --method=get repos/o/r',
    'gh --version',
    // Text that only looks like the tools.
    'ls .git',
    'cat .github/workflows/ci.yml',
    'npm --prefix backend run test',
    'node --test',
    'echo gitlab',
  ]) {
    it(`allows: ${command}`, () => {
      assertAllowed(bash(command));
    });
  }

  for (const command of [
    // The commands named in the project rules.
    'git commit -m x',
    'git push',
    'git push origin main',
    'git merge main',
    'git rebase main',
    'git reset --hard',
    'git checkout -- backend/src/app.ts',
    'git stash',
    'git stash pop',
    'git stash list',
    'git tag v1',
    'gh pr create --fill',
    'gh pr merge 1',
    // Other commands that change history, refs or the working tree.
    'git checkout main',
    'git switch -c x',
    'git restore .',
    'git clean -fd',
    'git cherry-pick abc',
    'git revert abc',
    'git am x.patch',
    'git apply x.patch',
    'git pull',
    'git fetch',
    'git add .',
    'git rm a',
    'git mv a b',
    'git update-ref refs/heads/main HEAD',
    'git filter-branch',
    'git worktree add ../x',
    'git submodule update',
    'git init',
    'git clone https://example.com/x',
    'git branch -D feature',
    'git branch --delete feature',
    'git branch -m a b',
    'git branch new-branch',
    'git remote add evil https://example.com',
    'git remote set-url origin https://example.com',
    'git config user.name x',
    'git config --global core.hooksPath /tmp',
    'gh pr close 1',
    'gh pr comment 1 --body x',
    'gh pr edit 1 --title x',
    'gh pr review 1 --approve',
    'gh issue create',
    'gh workflow run ci.yml',
    'gh secret set KEY',
    'gh repo delete o/r',
    'gh release create v1',
    'gh api -X POST repos/o/r/issues',
    'gh api -XPOST repos/o/r/issues',
    'gh api --method POST repos/o/r/issues',
    'gh api --method=DELETE repos/o/r',
    'gh api repos/o/r/issues -f title=x',
    'gh api repos/o/r/issues --raw-field title=x',
    'gh api repos/o/r --input body.json',
    // Forms that a permissions.deny pattern does not see.
    'git -C . push origin main',
    'git -C backend commit -m x',
    'git --git-dir=.git push',
    'git --git-dir .git --work-tree . push',
    'git --no-pager push',
    'git -c push.default=current push origin main',
    'git -c core.fsmonitor=evil status',
    'git -c alias.x=!evil x',
    '/usr/bin/git push origin main',
    './git push',
    "git 'push' origin main",
    'git "push" origin main',
    'g\\it status --help && git\\ push',
    'sh -c "git push origin main"',
    "bash -c 'git commit -m x'",
    'zsh -c "git reset --hard"',
    'env FOO=1 git push',
    'FOO=bar git push',
    'timeout 30 git push',
    'cd backend && git push',
    'git status; git push',
    'git status || git push',
    'git status | git commit -F -',
    'git status &\ngit push',
    '(git push)',
    'echo $(git push)',
    'echo `git push`',
    'for x in 1; do git push; done',
    'xargs git push',
    'find . -maxdepth 0 -exec git push ;',
    'node -e "require(\'child_process\').execSync(\'git push\')"',
    'python3 -c "import os; os.system(\'git push\')"',
    'git $(echo push)',
    'git `echo push`',
    'git $SUBCOMMAND origin',
    'git "$SUBCOMMAND" origin',
    // Read commands used to write a file or run a program.
    'git log --output=backend/src/app.ts',
    'git diff --output=x.patch',
    'git diff --ext-diff',
    'git diff --no-index /etc/passwd /dev/null',
    'git grep -Oevil pattern',
    'git grep --open-files-in-pager=evil pattern',
    'git ls-remote --upload-pack=evil origin',
    'git ls-remote --exec=evil origin',
    // Flags in front of the subcommand must not hide it.
    'gh --repo o/r pr create',
    'gh -R o/r pr merge 1',
    'gh --repo o/r api -X POST x',
  ]) {
    it(`blocks: ${JSON.stringify(command)}`, () => {
      assertDenied(bash(command));
    });
  }

  it('allows other tools without inspecting them', () => {
    assertAllowed(runHook({ cwd: repo, tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }));
  });

  it('blocks a Bash call with no command', () => {
    assertDenied(runHook({ cwd: repo, tool_name: 'Bash', tool_input: {} }));
  });
});

describe('failing closed', () => {
  for (const [name, input] of [
    ['empty input', ''],
    ['input that is not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['no tool name', '{}'],
    ['a tool name that is not a string', '{"tool_name":1}'],
  ]) {
    it(`blocks ${name}`, () => {
      assertDenied(runHook(input));
    });
  }

  it('blocks when the allowlist module cannot be loaded', () => {
    const broken = join(sandbox, 'broken');
    cpSync(join(repo, '.claude/hooks'), join(broken, '.claude/hooks'), { recursive: true });
    const result = spawnSync(process.execPath, [join(broken, '.claude/hooks/guard-tools.mjs')], {
      input: '{"tool_name":"Read"}',
      encoding: 'utf8',
    });
    // Node exits with 1 here and a non-2 exit does not block on its own.
    // settings.json sets onFailure: "block" for this case, see settings.test.mjs.
    assert.notEqual(result.status, 0);
  });
});
