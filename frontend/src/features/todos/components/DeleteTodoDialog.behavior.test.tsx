import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { useDeleteTodoMutation } from '../hooks/useDeleteTodoMutation'
import { DeleteTodoDialog } from './DeleteTodoDialog'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('../hooks/useDeleteTodoMutation', () => ({
  useDeleteTodoMutation: vi.fn(),
}))

const onClose = vi.fn()
const onDeleted = vi.fn()

function setup(
  mutation: {
    isPending?: boolean
    error?: Error | null
    mutateAsync?: unknown
  },
  busy = false,
) {
  vi.mocked(useDeleteTodoMutation).mockReturnValue({
    isPending: false,
    error: null,
    mutateAsync: vi.fn(),
    ...mutation,
  } as unknown as ReturnType<typeof useDeleteTodoMutation>)
  render(
    <DeleteTodoDialog
      todo={todoFixture}
      busy={busy}
      onClose={onClose}
      onDeleted={onDeleted}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('deletes the task by id and then reports it as deleted', async () => {
  const user = userEvent.setup()
  const order: string[] = []
  const mutateAsync = vi.fn(async () => {
    order.push('request')
  })
  onDeleted.mockImplementation(() => order.push('deleted'))
  setup({ mutateAsync })
  await user.click(screen.getByRole('button', { name: 'Delete task' }))
  expect(mutateAsync).toHaveBeenCalledExactlyOnceWith(todoFixture.id)
  expect(order).toEqual(['request', 'deleted'])
})

it('stays open and does not report deletion when the request fails', async () => {
  const user = userEvent.setup()
  const mutateAsync = vi.fn().mockRejectedValue(new Error('down'))
  setup({ mutateAsync })
  await user.click(screen.getByRole('button', { name: 'Delete task' }))
  expect(mutateAsync).toHaveBeenCalledTimes(1)
  expect(onDeleted).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: 'Delete task?' })).toBeVisible()
})

it('cannot be cancelled, deleted or closed while the deletion is running', () => {
  setup({ isPending: true })
  expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
})

it('is locked while the page is busy', () => {
  setup({}, true)
  expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
})

it('can be closed when nothing is running', async () => {
  const user = userEvent.setup()
  setup({})
  expect(screen.getByRole('button', { name: 'Delete task' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: 'Close' }))
  expect(onClose).toHaveBeenCalledTimes(1)
})
