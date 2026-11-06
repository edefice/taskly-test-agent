# Security review and limitations

This file holds the full list of limitations behind the short one in [SOLUTION.md](../SOLUTION.md), and a summary of each security review. The reviewer is [`.claude/agents/security-reviewer.md`](../.claude/agents/security-reviewer.md): read-only (Read, Grep, Glob), run by hand in a fresh context. Each finding was checked against the code before a decision. † marks a local measurement whose record is not in this repository.

## Review runs

| Run | State reviewed | Counts | Findings | Outcome |
|---|---|---|---|---|
| 1 | Before [#11][pr11]. Ran as a `Plan` subagent with the same instructions, because the new agent type had not loaded. Bash was forbidden only by the instructions. | Partly: the owner switched branches during the run | 1 high, 2 medium, 4 low | Fixed in #11: `branches: [main]`, a filter for numeric fields in the report, Grep and Glob patterns for `.env*` in the hook |
| 2 | The state before #11, by mistake: a worktree starts from the default branch, not from the current one | No | Added one point: a forged `outcome: "fork"` turns off the comment and the Check | Kept with the forged gate below |
| 3 | `main` at `2e954b0`, prompt version 4 | Yes | 1 high, 2 medium, 5 low | Fixed in [#13][pr13]: `package-manager-cache: false` in the jobs with the key or write access, and `..` checked after brace expansion in the hook |
| 4 | `main` at `67ddee2`, prompt version 6 | Yes | 1 high, 3 medium, 3 low | Nothing fixed. All in the table below. |

Corrections made during the checks:

- Run 1 proposed a path through `NODE_OPTIONS` in `GITHUB_ENV`. The runner blocks that, but other paths for a forged gate stay.
- Run 3: `.gitattributes` with `-diff` was confirmed by a trial, and `{..,x}/**` passing the hook was confirmed on the real hook. Both were my own gaps in earlier fixes.
- Run 4, finding about a root `.env`: one local trial on CLI 2.1.317 with a Pro login did not confirm it. With `ANTHROPIC_BASE_URL=http://127.0.0.1:9` in a `.env` file, the CLI answered normally†. Not covered: a login with an API key as in CI, a control with the variable set in the environment, and a `bunfig.toml` preload.

What no review found:

- The action restores `.claude/` from `origin/main`, while the tools come from `base.sha`. This was left in on purpose, to see whether a review finds it.
- Run 1 listed a nested `CLAUDE.md` only as an assumption it could not check. A trial that cost under one cent† found a larger gap: CLI 2.1.317 reads `AGENTS.md`, against its documentation, and the action does not restore it. Instruction files that come with a pull request are now removed by code before the agent starts.

## Open findings

People with no write access got no path to the key: forks stop at the guard and get no secret. Every finding below needs write access, and the first already gives such a person the key.

| Severity | Finding | Decision and why |
|---|---|---|
| High | A person with write access can read the key through a workflow on a branch, because `pull_request` reads the YAML from the branch. | Stays. An Environment with an approval on each run breaks the flow of this MVP, and the workspace limit of $10 bounds the damage. The production fix is in SOLUTION.md. |
| Medium | A root `.env` or `bunfig.toml` from the pull request stays in the checkout when the action starts with the key. The action runs its own `bun` with `--no-env-file`, and one local trial showed the CLI ignoring `.env`. | Stays, not confirmed. The fix is to remove `.env*` and `bunfig.toml` in the step that removes instruction files. |
| Medium | `verify` runs code from the pull request, so it can forge the result, the patch, `regressions.json` and the next round. `commit` checks paths, status and mode, not the test rules, so the bot can commit weakened or hostile tests, including a test that uses `child_process` or `fetch` after a steered agent writes it. | Stays. The same author can change tests without the bot, so the gain is the bot's name. Human review of bot commits is the control. |
| Medium | The bot's marker is plain text. In the last commit it skips the run, the report and the Check. In an earlier commit it moves the start of the diff, and the prompt then says, outside the data tags, that no source file changed. | Stays. The agent still gets the full file list. The fix is to trust a commit only when the bot's Check exists on it. |
| Low | The label, or `.gitattributes` with `-diff`, skip the agent with a green Check, because the analysis reads `--numstat` without `--text`. | Stays, because the Check is advisory. |
| Low | Forged artifacts can set the Check, or break the report so that no comment appears. | Stays, for the same reason. |
| Low | No limit on the number of runs, and the size limit of the diff counts characters, not bytes. `--max-budget-usd 0.05` ended at $0.2263†, so that limit is soft. | Stays. The workspace limit is the hard one. |
| Low | A local run trusts the branch: its tests, hook and settings. Instruction files are removed only in CI. | Stays, because the developer chooses what to run. |
| Not found by a review | `.claude/` comes from `origin/main`, tools from `base.sha`. | Stays. With `branches: [main]` both are `main`, though not always the same commit. |
| Hardening | `analyze` keeps the automatic cache of `setup-node`. The hook checks search patterns, not results, so `**/*` passes. The scan misses a key that is cut, reversed or compressed. | Stays. `analyze` has no key and no write access, CI has no `.env`, and the model has no path to the key. |

Public data: transcripts and patches stay in public artifacts for 30 days, after the scan, and the action prints the prompt in its log. The prompt holds data from the pull request and no secret.

## Other limitations

- **"No tests needed" has no check.** Mutations run only after accepted tests, so a wrong decision gives green (`Math.floor` on #12, v5). The headline and `success` are also too strong when `suspected_bugs` is not empty (#12, v6).
- **Reading is not enforced.** Reading the changed files is an instruction, code does not check it, and the agent skipped it once (#18, first push).
- **A deliberate change that breaks tests is not updated.** The agent reports it and leaves the decision to a person (#15).
- **Repair rounds can be wasted.** Round 2 on #12 fixed only metadata despite the contract in the prompt, and an equivalent mutant costs a round (#18).
- **The stale report misleads.** It says the run for the newest commit reports instead, but when that commit is the bot's, no report comes, and it lists tests that were not committed (#18).
- **The bot's commit gets no CI** until a person approves the runs (`action_required`).
- **Checked only partly.** A block by the hook was never seen under the action, only allowed events. It is covered by tests and local runs. The `concurrency` fix is covered by a rule and `actionlint`, not by a run.
- **Small samples.** Most behaviors of the model rest on one run per prompt version.
- **Cut for time.** A pull request that fixes B1 and B2 through the workflow.

[pr11]: https://github.com/edefice/taskly-test-agent/pull/11
[pr13]: https://github.com/edefice/taskly-test-agent/pull/13
