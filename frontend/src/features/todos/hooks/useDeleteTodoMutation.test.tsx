import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import type { Todo } from '../types'
import { useDeleteTodoMutation } from './useDeleteTodoMutation'

vi.mock('../api/todos', () => ({ todosApi: { remove: vi.fn() } }))

const other: Todo = { ...todoFixture, id: 8, title: 'Other' }

function setup(cached?: Todo[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (cached) queryClient.setQueryData(todoKeys.list, cached)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useDeleteTodoMutation(), { wrapper })
  return { queryClient, result }
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('removes the deleted todo from the cached list', async () => {
  vi.mocked(todosApi.remove).mockResolvedValue(undefined)
  const { queryClient, result } = setup([todoFixture, other])
  await act(() => result.current.mutateAsync(todoFixture.id))
  expect(todosApi.remove).toHaveBeenCalledWith(todoFixture.id)
  expect(queryClient.getQueryData(todoKeys.list)).toEqual([other])
})

it('does not create a list when nothing is cached', async () => {
  vi.mocked(todosApi.remove).mockResolvedValue(undefined)
  const { queryClient, result } = setup()
  await act(() => result.current.mutateAsync(todoFixture.id))
  expect(queryClient.getQueryData(todoKeys.list)).toBeUndefined()
})

it('keeps the cached list when the request fails', async () => {
  vi.mocked(todosApi.remove).mockRejectedValue(new Error('down'))
  const { queryClient, result } = setup([todoFixture, other])
  await act(async () => {
    await expect(result.current.mutateAsync(todoFixture.id)).rejects.toThrow(
      'down',
    )
  })
  expect(queryClient.getQueryData(todoKeys.list)).toEqual([todoFixture, other])
})

it('is not overwritten by an older list fetch that finishes later', async () => {
  vi.mocked(todosApi.remove).mockResolvedValue(undefined)
  const { queryClient, result } = setup([todoFixture, other])
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
  await act(() => result.current.mutateAsync(todoFixture.id))
  resolveList([todoFixture, other])
  await pending
  expect(queryClient.getQueryData(todoKeys.list)).toEqual([other])
})
