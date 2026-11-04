import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import type { Todo } from '../types'
import { useUpdateTodoMutation } from './useUpdateTodoMutation'

vi.mock('../api/todos', () => ({ todosApi: { update: vi.fn() } }))

const other: Todo = { ...todoFixture, id: 8, title: 'Other' }
const saved: Todo = { ...todoFixture, completed: true }

function setup(cached?: Todo[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (cached) queryClient.setQueryData(todoKeys.list, cached)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useUpdateTodoMutation(), { wrapper })
  return { queryClient, result }
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('replaces only the updated todo in the cached list', async () => {
  vi.mocked(todosApi.update).mockResolvedValue(saved)
  const { queryClient, result } = setup([todoFixture, other])
  await act(() =>
    result.current.mutateAsync({
      id: todoFixture.id,
      input: { completed: true },
    }),
  )
  expect(todosApi.update).toHaveBeenCalledWith(todoFixture.id, {
    completed: true,
  })
  expect(queryClient.getQueryData(todoKeys.list)).toEqual([saved, other])
})

it('does not create a list when nothing is cached', async () => {
  vi.mocked(todosApi.update).mockResolvedValue(saved)
  const { queryClient, result } = setup()
  await act(() =>
    result.current.mutateAsync({
      id: todoFixture.id,
      input: { completed: true },
    }),
  )
  expect(queryClient.getQueryData(todoKeys.list)).toBeUndefined()
})

it('keeps the cached list when the request fails', async () => {
  vi.mocked(todosApi.update).mockRejectedValue(new Error('down'))
  const { queryClient, result } = setup([todoFixture])
  await act(async () => {
    await expect(
      result.current.mutateAsync({ id: todoFixture.id, input: {} }),
    ).rejects.toThrow('down')
  })
  expect(queryClient.getQueryData(todoKeys.list)).toEqual([todoFixture])
})

it('is not overwritten by an older list fetch that finishes later', async () => {
  vi.mocked(todosApi.update).mockResolvedValue(saved)
  const { queryClient, result } = setup([todoFixture])
  let resolveList: (list: Todo[]) => void = () => {}
  const pending = queryClient
    .fetchQuery({
      queryKey: todoKeys.list,
      queryFn: () =>
        new Promise<Todo[]>((resolve) => {
          resolveList = resolve
        }),
    })
    .catch(() => undefined)
  await act(() =>
    result.current.mutateAsync({
      id: todoFixture.id,
      input: { completed: true },
    }),
  )
  resolveList([todoFixture])
  await pending
  expect(queryClient.getQueryData(todoKeys.list)).toEqual([saved])
})
