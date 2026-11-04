# Taskly App Node

A todo application: a React frontend in `frontend/` and an Express API with Prisma and PostgreSQL in `backend/`. The two are separate npm packages. The `package.json` in the root only holds tooling for the unit test agent.

This repository also holds a unit test agent that runs locally and on pull requests. Its code is in `.claude/` and `scripts/`.

## Commands

Run these from the repository root.

| Task | Command |
|---|---|
| Backend tests | `npm --prefix backend test` |
| Backend coverage | `npm --prefix backend run test:coverage` |
| Backend typecheck | `npm --prefix backend run typecheck` |
| Frontend tests | `npm --prefix frontend test` |
| Frontend coverage | `npm --prefix frontend run test:coverage` |
| Frontend typecheck | `npm --prefix frontend run typecheck` |
| Frontend format check | `npm --prefix frontend run format:check` |
| Agent tooling tests | `npm test` |
| Check all workflows, before committing a change to one | `actionlint` |
| Run the agent on a branch | `npm run test-agent -- --base main` |
| Show what it would do, with no API key | `npm run test-agent -- --base main --dry-run` |

Fresh setup: `npm ci` in each package. The backend needs `prisma generate`, which its `postinstall` runs. Tests need no database. `actionlint` is installed separately, for example with `brew install actionlint`.

## Dependency versions

The versions are exact, and a test keeps this table equal to `package.json`.

| Package | Dependency | Version |
|---|---|---|
| backend | `express` | 5.2.1 |
| backend | `@prisma/client` | 7.10.0 |
| backend | `zod` | 4.6.5 |
| backend | `vitest` | 4.1.11 |
| backend | `supertest` | 7.3.1 |
| backend | `@stryker-mutator/core` | 10.1.1 |
| frontend | `react` | 19.3.0 |
| frontend | `@tanstack/react-query` | 5.104.1 |
| frontend | `vitest` | 4.1.11 |
| frontend | `@testing-library/react` | 16.3.3 |
| frontend | `@testing-library/user-event` | 14.6.7 |
| frontend | `jsdom` | 26.1.0 |
| frontend | `@stryker-mutator/core` | 10.1.1 |

## Test conventions

- Backend tests are in `backend/tests/*.test.ts`. They import source files with the `.ts` extension and use semicolons. The backend has no formatter.
- Frontend tests sit next to the code as `*.test.ts` or `*.test.tsx`. Prettier formats them, with no semicolons.
- Both packages import from `vitest` explicitly.
- Details and examples are in the `backend-unit-tests` and `frontend-unit-tests` skills.

## Rules for the agent

- Change only test files and shared test support. If the application looks wrong, report it and do not fix it.
- Before you report a bug that depends on how a library behaves, check its version in the table above or in `package.json`. Behavior from another major version is not a bug here. For example, Express 5 passes a rejected async handler to the error handler, and Express 4 does not.
- Do not write a test that presents a known bug below as correct behavior.

## Known bugs

These are reported and not fixed yet. Do not add tests that expect the current behavior.

- B1, `backend/src/features/todos/validators.ts:22`: the ID schema allows values up to `Number.MAX_SAFE_INTEGER`, but the column is a 32-bit `Int`. `GET`, `PATCH` and `DELETE /api/todos/2147483648` return 500. Expected: 404 or 422.
- B2, `backend/src/features/todos/validators.ts:22`: `z.coerce.number()` accepts `1e0`, `0x1` and `" 1"` as ID 1. Expected: 422.
- B3, `backend/src/core/lifespan.ts:14-15`: when the port is taken, Express 5 calls the `listen` callback with the error, so `resolve` wins over `reject`, and `start()` rejects with a `TypeError` from `server.address()`. Expected: it rejects with `EADDRINUSE`.
- B4, `backend/src/core/lifespan.ts:29-31`: when startup fails and `$disconnect()` fails too, the second error replaces the first. Expected: the caller gets the startup error.

## Agent and skills

| What | Where |
|---|---|
| Agent definition, model and prompt version | `.claude/agents/unit-test-agent.md` |
| Deciding whether tests are needed | `.claude/skills/pr-change-analysis/` |
| Writing backend tests | `.claude/skills/backend-unit-tests/` |
| Writing frontend tests | `.claude/skills/frontend-unit-tests/` |
| The gate that accepts or rejects tests | `.claude/skills/test-verification/` |
| The result schema and the report | `.claude/skills/pr-report/` |
| What the agent may change | `.claude/lib/test-paths.mjs` |
| The hook that enforces it | `.claude/hooks/guard-tools.mjs` |
| The local runner | `scripts/test-agent.mjs` |
| The workflow | `.github/workflows/test-agent.yml` and `test-agent-round.yml` |
| The steps of the workflow | `scripts/ci/` |
| What a test keeps true in the workflow | `scripts/ci/workflow-rules.mjs` |

When you change the agent definition or a skill, raise `AGENT_PROMPT_VERSION` in the agent definition.

## Lessons

Add to this list after each mistake.

- In zsh, `PIPESTATUS` does not exist. Use `pipestatus`, or redirect to a file and read `$?`.
- In zsh, an unquoted variable does not split into words, so `node --test $FILES` with two paths ran nothing and looked like an empty result. Check that the control run of a mutation test reports passing tests.
- The text coverage report hides files at 100%. Use `coverage/coverage-summary.json` for exact numbers.
- A test with a fake runner proves little about Vitest or the Claude Code CLI. Run the real tool once before trusting a new script.
- The `skills` field in an agent definition loads nothing when the agent is the main session (`--agent` with `-p`). `build-prompt.mjs` places those skills in the prompt.
- A model can skip a skill it is told to load. It did in a real run, and a passing gate did not show it. What must reach the agent goes in the prompt through code: `build-prompt.mjs` picks the skills for writing tests from `source_files`.
- An example in a skill must not come from a module that still needs tests. The agent could copy it, and the coverage would look like its own work.
- Claude Code removes Grep and Glob when Bash is present, unless `--tools` names them. Do not name Read, Grep or Glob in `--allowedTools`, because that approves reads outside the repository.
- In zsh, an unquoted `?` in a URL or `*` in a flag is a glob, and `no matches found` stops the whole command. Quote such arguments.
- In zsh, `path` is tied to `PATH`, so `path=$1` in a shell function removes every command that follows. Use another name.
- BSD `sed` does not understand `\t` or `\x1b`, and `gh run view --log` writes color codes as the literal text `^[[`. A filter that finds nothing can mean the filter is wrong, so check the raw text before you trust an empty result.
- Node 22 prints a TAP summary by default (`# tests 874`) and Node 24 prints spec (`ℹ tests 874`). Use the exit code in scripts, not the text.
- Stryker reports 35 of 35 and a test can still be weak: it does not remove props, calls or fields, so a mock that ignores a prop hides a gap. On those tests, 4 of 6 hand-made mutations survived. Do not present a mutation score as proof of test quality.
- A check of the agent's words per file raises a false alarm on a true "I added tests, the existing ones are unchanged". Compare each existing test by itself.
- macOS has no `timeout` command, and a missing command in a chain can look like a finished step. Set the limit in the tool that runs the command.
- `spawnSync` blocks the whole process, so a server in the same process cannot answer the child. Use `spawn` when the child talks to it.
- A workflow can pass every test and still fail on the first real run, for example a shallow checkout where a script needs the merge base. Read the YAML against what each script needs, and rehearse the steps with real tools before a paid run.
- On Linux, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` makes Claude Code refuse to start without `bubblewrap`, and a run on macOS or a rehearsal with the model stood in for does not show it. It stopped the first real run on GitHub.
- The `env` of a step that uses a composite action reaches every step inside that action. Give a secret as an input, and read the `action.yml` to see where the input goes.
- The guard hook reads command text, so any Bash command containing `git` followed by a word can be blocked, even in a string. If that is a false alarm, use the Grep tool or a file for the text.
