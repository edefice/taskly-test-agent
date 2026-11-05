import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todosApi } from '../api/todos'
import { useTodoSummaryQuery } from './useTodoSummaryQuery'

vi.mock('../api/todos', () => ({ todosApi: { summary: vi.fn() } }))

beforeEach(() => vi.clearAllMocks())

const first = {
  total: 1,
  completed: 0,
  active: 1,
  overdue: 0,
  percent_complete: 0,
}
const second = { ...first, total: 2, active: 2 }

function setup(initial: number) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(({ revision }) => useTodoSummaryQuery(revision), {
    wrapper,
    initialProps: { revision: initial },
  })
}

it('loads the summary with an abort signal', async () => {
  vi.mocked(todosApi.summary).mockResolvedValue(first)
  const { result } = setup(1)
  await waitFor(() => expect(result.current.data).toEqual(first))
  expect(todosApi.summary).toHaveBeenCalledWith(expect.any(AbortSignal))
})

it('reloads on a new revision and shows the old data meanwhile', async () => {
  vi.mocked(todosApi.summary).mockResolvedValueOnce(first)
  const { result, rerender } = setup(1)
  await waitFor(() => expect(result.current.data).toEqual(first))

  vi.mocked(todosApi.summary).mockResolvedValueOnce(second)
  rerender({ revision: 2 })
  expect(result.current.data).toEqual(first)
  await waitFor(() => expect(result.current.data).toEqual(second))
  expect(todosApi.summary).toHaveBeenCalledTimes(2)
})
