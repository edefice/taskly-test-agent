---
name: pr-report
description: Defines the structured result the unit test agent must return and how the report for a pull request is built from it. Use before finishing a run, to fill in the result correctly.
---

# PR report

You fill in one structured result. A script combines it with facts from the analysis, the gate and the transcript, and renders the report through a fixed template. You never write the report or a pull request comment yourself.

## When to use

Before you finish a run, whatever the outcome. A run with no valid result counts as a failure.

## Steps

1. Choose the decision:
   - `tests_added`: you added at least one new test.
   - `tests_updated`: you changed existing test files only.
   - `no_tests_needed`: a deliberate choice. Say why in `reasoning`.
   - `failed`: you could not finish. Say why in `reasoning`.
2. List every file you created or changed in `files`.
3. Add every new test to `tests`, with one sentence about the behavior it checks.
4. Fill in the other lists, or leave them empty:
   - `existing_tests_changed`: an existing test you changed, and why the pull request requires it.
   - `suspected_bugs`: application behavior that looks wrong, with what you expected and what happens.
   - `regressions`: existing tests the pull request breaks. Do not fix these.
5. Return the result with the `StructuredOutput` tool.

## What the report takes from where

| Fact | Source | Why |
|---|---|---|
| Decision, reasoning, test descriptions | Your result | Only you know why. |
| Changed files | The gate | The result must match them, or it is rejected. |
| Test results and coverage | The gate | Your opinion of your tests does not count. |
| Skills used | The transcript | It records real tool calls. |
| Check result (green, neutral, red) | Code | Red means existing tests pass on the base commit and fail on the pull request. Your `regressions` list cannot turn the check red. |
| Turns, cost, model | The transcript | Measured, not stated. |

Text from your result goes through a filter. Mentions, HTML, links and code spans are removed or escaped, so write plain sentences.

## Quality checklist

- [ ] `files` lists every file you changed, and nothing else.
- [ ] Each behavior sentence says what the code does for its user, not how the test works. If you cannot write that sentence, remove the test.
- [ ] Each changed existing test has a justification.
- [ ] `reasoning` states the actual reason, in at most three sentences.

## Examples from this repository

Good behavior sentences, based on existing tests in `backend/tests/router.test.ts` and `frontend/src/features/todos/TodosPage.test.tsx`:

- "Invalid input to create a task returns 422 and never reaches the repository."
- "A failed task query shows the server's message, and retrying resets earlier mutation errors."

Weak behavior sentences, which mean the test should go:

- "Calls the function." It does not say what should happen.
- "Renders without crashing." Almost nothing could make this fail.

## Rendering by hand

```sh
node .claude/skills/pr-report/scripts/validate-result.mjs --result result.json --verify verify.json
node .claude/skills/pr-report/scripts/render-report.mjs --input report-input.json
```
