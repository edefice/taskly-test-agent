import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { todoKeys } from '../api/queryKeys'
import { todosApi } from '../api/todos'
import type { Todo, TodoInput } from '../types'
import { useCreateTodoMutation } from './useCreateTodoMutation'

vi.mock('../api/todos', () => ({ todosApi: { create: vi.fn() } }))

const input = { title: 'New' } as TodoInput
const other: Todo = { ...todoFixture, id: 8, title: 'Other' }

function setup(cached?: Todo[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (cached) queryClient.setQueryData(todoKeys.list, cached)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useCreateTodoMutation(), { wrapper })
  return { queryClient, result }
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('puts the created todo first in the cached list', async () => {
  vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
  const { queryClient, result } = setup([other])
  await act(() => result.current.mutateAsync(input))
  expect(todosApi.create).toHaveBeenCalledWith(input)
  expect(queryClient.getQueryData(todoKeys.list)).toEqual([todoFixture, other])
})

it('does not duplicate a todo that is already cached', async () => {
  vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
  const { queryClient, result } = setup([other, { ...todoFixture, title: 'x' }])
  await act(() => result.current.mutateAsync(input))
  expect(queryClient.getQueryData(todoKeys.list)).toEqual([todoFixture, other])
})

it('creates the list when nothing is cached', async () => {
  vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
  const { queryClient, result } = setup()
  await act(() => result.current.mutateAsync(input))
  expect(queryClient.getQueryData(todoKeys.list)).toEqual([todoFixture])
})

it('keeps the cached list when the request fails', async () => {
  vi.mocked(todosApi.create).mockRejectedValue(new Error('down'))
  const { queryClient, result } = setup([other])
  await act(async () => {
    await expect(result.current.mutateAsync(input)).rejects.toThrow('down')
  })
  expect(queryClient.getQueryData(todoKeys.list)).toEqual([other])
})

it('is not overwritten by an older list fetch that finishes later', async () => {
  vi.mocked(todosApi.create).mockResolvedValue(todoFixture)
  const { queryClient, result } = setup([other])
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
  await act(() => result.current.mutateAsync(input))
  resolveList([other])
  await pending
  expect(queryClient.getQueryData(todoKeys.list)).toEqual([todoFixture, other])
})
