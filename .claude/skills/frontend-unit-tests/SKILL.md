---
name: frontend-unit-tests
description: How to write unit tests for the React frontend in frontend/src, using Vitest and React Testing Library. Use when a frontend source file needs new or changed tests.
---

# Frontend unit tests

Test what a user can see and do: find elements by role and text, act through `userEvent`, and check the result on the screen or the callback that fired. Do not test component internals, styles or markup structure.

## When to use

When `frontend/src/**` has a change that needs tests. If the change has no behavior to check, `pr-change-analysis` tells you to stop before this skill.

## Steps

1. Read the source file and the test next to it.
2. List what the user can now see or do differently, including empty, loading and error states.
3. Add tests to the test next to the source file. If there is none, create it there: `http.ts` gets `http.test.ts`, `TodoList.tsx` gets `TodoList.test.tsx`.
4. Reuse `todoFixture` from `frontend/src/test/todoFixture.ts`.
5. Verify with the `test-verification` skill.

## Conventions

- Tests sit next to the code as `*.test.ts` or `*.test.tsx`.
- Import from `vitest` explicitly, even though the types are global.
- No semicolons, single quotes, trailing commas. The gate runs Prettier on your files.
- Do not edit `frontend/src/test/setup.ts`. It is blocked.
- The design system is excluded from coverage and mocked in the tests that use it, as below.

## Choosing the level

| Code under test | How to test it |
|---|---|
| A component | Render it with the design system mock, and pass `vi.fn()` callbacks. |
| A page that uses hooks | Mock each hook with `vi.mocked(...).mockReturnValue(...)`, and mock child components that are tested on their own. |
| An API function | Mock `request` from `lib/http` and assert on the call. |
| A plain function | Call it directly. |

## Examples from this repository

Replace the design system with the shared mock. Adjust the relative path (`frontend/src/features/todos/components/TodoItem.test.tsx`):

```tsx
vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
```

Act like a user and check through roles and text (`frontend/src/features/todos/components/TodoItem.test.tsx`):

```tsx
  expect(screen.getByRole('heading', { name: todoFixture.title })).toBeVisible()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  await user.click(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  )
  expect(onEdit).toHaveBeenCalledTimes(1)
  expect(onToggle).not.toHaveBeenCalled()
```

Mock a hook with only the fields the page reads (`frontend/src/features/todos/TodosPage.test.tsx`):

```tsx
  vi.mocked(useTodosQuery).mockReturnValue({
    data: [],
    isPending: false,
    isFetching: false,
    isError: true,
    error: new Error('The server is unavailable.'),
    refetch,
  } as unknown as ReturnType<typeof useTodosQuery>)
```

Check the request an API function sends (`frontend/src/features/todos/api/todos.test.ts`):

```ts
vi.mock('../../../lib/http', () => ({ request: vi.fn() }))
```

```ts
  await expect(todosApi.list(signal)).resolves.toEqual([todoFixture])
  expect(request).toHaveBeenCalledWith('/todos', { signal })
```

## Environment limits

- jsdom has no `dialog.showModal`. The real `Drawer` fails on it, so use the design system mock.
- `frontend/src/design-system/mocks.tsx` is imported by many tests. Change it only if a test cannot be written otherwise, because the gate then runs the whole package and the report lists the change separately.
- To test `frontend/src/lib/http.ts`, replace `fetch` with `vi.stubGlobal` and remove it with `vi.unstubAllGlobals()` in `afterEach`.

## What to cover

- Each state the user can reach: empty, loading, error, success.
- Each interaction: what the user clicks or types, and what happens next.
- Text shown from an error or a notice.
- Conditions that change what renders, such as a completed task or a busy state.

## Quality checklist

- [ ] Queries use role, label or text. `getByTestId` is a last resort.
- [ ] No snapshots. The gate rejects them.
- [ ] Interactions use `userEvent.setup()`, not direct calls to props.
- [ ] A test can fail if the user-visible behavior breaks.
- [ ] You can describe each test in one sentence about behavior.
