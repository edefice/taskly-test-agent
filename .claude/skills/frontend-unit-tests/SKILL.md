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
| A hook that uses TanStack Query | `renderHook` with a `QueryClientProvider` wrapper. Mock the API module and check the cache. See below. |
| A hook with a timer | `renderHook` with fake timers. See "Time" below. |
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

## Hooks that use TanStack Query

Build a new `QueryClient` in every test, so that no cache reaches the next test. Turn off query retries, because the default retries make a failing query time out. Put the starting list in the cache with `setQueryData`, and check the result with `getQueryData`: the cache is what the page shows next. Also test a request that fails.

The modules in this example are made up. They do not exist in this repository, so read the real hook and test what it does. For this hook:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { exampleApi } from './exampleApi'

export function useExampleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => exampleApi.save(name),
    onSuccess: (saved) => {
      queryClient.setQueryData<string[]>(['examples'], (current = []) => [
        ...current,
        saved,
      ])
    },
  })
}
```

the test looks like this:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { exampleApi } from './exampleApi'
import { useExampleMutation } from './useExampleMutation'

vi.mock('./exampleApi', () => ({ exampleApi: { save: vi.fn() } }))

function setup(cached: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  queryClient.setQueryData(['examples'], cached)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useExampleMutation(), { wrapper })
  return { queryClient, result }
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('adds the saved item to the cached list', async () => {
  vi.mocked(exampleApi.save).mockResolvedValue('b')
  const { queryClient, result } = setup(['a'])
  await act(() => result.current.mutateAsync('b'))
  expect(queryClient.getQueryData(['examples'])).toEqual(['a', 'b'])
})

it('keeps the cached list when the request fails', async () => {
  vi.mocked(exampleApi.save).mockRejectedValue(new Error('down'))
  const { queryClient, result } = setup(['a'])
  await act(async () => {
    await expect(result.current.mutateAsync('b')).rejects.toThrow('down')
  })
  expect(queryClient.getQueryData(['examples'])).toEqual(['a'])
})
```

## Time

Tests run in `TZ=UTC` in the gate, so a mistake that depends on the time zone does not show there. Never depend on the real clock or on the zone of the machine.

Plain `vi.useFakeTimers()` makes `waitFor`, `findBy*` and `userEvent` hang until the test times out. Testing Library only recognizes the fake timers of Jest, so its own `setTimeout` never fires under Vitest. Passing `advanceTimers` to `userEvent.setup` does not fix this. Choose one of these:

| The test needs | Use |
|---|---|
| No timer | Real timers. `waitFor` and `userEvent` work as usual. |
| An exact delay, and no `waitFor`, `findBy*` or `userEvent` | Plain `vi.useFakeTimers()`. Check just before the limit and at the limit. |
| A timer and a user action in one test | `vi.useFakeTimers({ shouldAdvanceTime: true })`. The fake clock also follows real time, so leave a margin and do not check the exact limit. Test the exact limit in the hook. |
| Today's date | `vi.setSystemTime(new Date(2026, 5, 15, 12))`. |

An exact delay, with a hook and plain fake timers. This hook is made up too:

```ts
import { useEffect, useState } from 'react'

export function useExampleTimeout(delay: number) {
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const timeout = window.setTimeout(() => setExpired(true), delay)
    return () => window.clearTimeout(timeout)
  }, [delay])
  return expired
}
```

```ts
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useExampleTimeout } from './useExampleTimeout'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

it('expires when the delay is up, and not before', () => {
  const { result } = renderHook(() => useExampleTimeout(1000))
  act(() => {
    vi.advanceTimersByTime(999)
  })
  expect(result.current).toBe(false)
  act(() => {
    vi.advanceTimersByTime(1)
  })
  expect(result.current).toBe(true)
})
```

A timer and a user action in one test:

```tsx
vi.useFakeTimers({ shouldAdvanceTime: true })
const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
```

Today's date. The constructor with numbers means local noon, which is the same calendar day in every time zone. A string that ends in `Z` can be a different local day:

```ts
vi.setSystemTime(new Date(2026, 5, 15, 12))
```

## Cleanup

`frontend/src/test/setup.ts` already unmounts components after each test. Clean up the rest yourself, because the gate runs your tests in a random order:

| You used | Add |
|---|---|
| `vi.useFakeTimers` or `vi.setSystemTime` | `afterEach(() => { vi.useRealTimers() })`. This also restores the real date. |
| `vi.stubGlobal` | `afterEach(() => { vi.unstubAllGlobals() })` |
| `vi.spyOn` | `afterEach(() => { vi.restoreAllMocks() })` |
| `vi.fn()`, also inside `vi.mock` | `beforeEach(() => { vi.clearAllMocks() })` for the calls. `vi.resetAllMocks()` also removes stubbed values. |

`vi.restoreAllMocks()` does not touch a `vi.fn()`. Its calls and stubbed values carry over to the next test, so a check like `not.toHaveBeenCalled()` can fail or pass because of another test.

## Environment limits

- jsdom has no `dialog.showModal`. The real `Drawer` fails on it, so use the design system mock.
- `frontend/src/design-system/mocks.tsx` is imported by many tests. Change it only if a test cannot be written otherwise, because the gate then runs the whole package and the report lists the change separately.
- To test code that calls `fetch`, replace `fetch` with `vi.stubGlobal` and remove it with `vi.unstubAllGlobals()` in `afterEach`.

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
- [ ] Nothing depends on the real clock, the time zone or the order of the tests.
- [ ] You can describe each test in one sentence about behavior.
