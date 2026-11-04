import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { useCreateTodoMutation } from '../hooks/useCreateTodoMutation'
import { useUpdateTodoMutation } from '../hooks/useUpdateTodoMutation'
import { TodoEditor } from './TodoEditor'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('../hooks/useCreateTodoMutation', () => ({
  useCreateTodoMutation: vi.fn(),
}))
vi.mock('../hooks/useUpdateTodoMutation', () => ({
  useUpdateTodoMutation: vi.fn(),
}))

type State = { isPending?: boolean; error?: Error | null }

function setup(create: State = {}, update: State = {}) {
  const createFn = vi.fn().mockResolvedValue(todoFixture)
  const updateFn = vi.fn().mockResolvedValue(todoFixture)
  vi.mocked(useCreateTodoMutation).mockReturnValue({
    isPending: false,
    error: null,
    mutateAsync: createFn,
    ...create,
  } as unknown as ReturnType<typeof useCreateTodoMutation>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    isPending: false,
    error: null,
    mutateAsync: updateFn,
    ...update,
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
  return { createFn, updateFn }
}

const task = { ...todoFixture, title: 'Existing task' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TodoEditor with the real form', () => {
  it('opens an edit drawer with the task filled in', () => {
    setup()
    render(
      <TodoEditor
        todo={task}
        busy={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Edit task' })).toBeVisible()
    expect(screen.getByLabelText(/Task title/)).toHaveValue('Existing task')
  })

  it('opens an empty form for a new task', () => {
    setup()
    render(
      <TodoEditor
        todo="new"
        busy={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    )
    expect(screen.getByLabelText(/Task title/)).toHaveValue('')
  })

  it('updates the task by id and reports the saved changes', async () => {
    const user = userEvent.setup()
    const { createFn, updateFn } = setup()
    const onSaved = vi.fn()
    render(
      <TodoEditor
        todo={task}
        busy={false}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    )
    await user.type(screen.getByLabelText(/Task title/), ' v2')
    await user.click(screen.getByRole('button', { name: 'Save task' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Changes saved.'))
    expect(updateFn).toHaveBeenCalledWith({
      id: task.id,
      input: expect.objectContaining({ title: 'Existing task v2' }),
    })
    expect(createFn).not.toHaveBeenCalled()
  })

  it('does not report a save when the request fails', async () => {
    const user = userEvent.setup()
    const { updateFn } = setup()
    updateFn.mockRejectedValue(new Error('down'))
    const onSaved = vi.fn()
    render(
      <TodoEditor
        todo={task}
        busy={false}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Save task' }))
    await waitFor(() => expect(updateFn).toHaveBeenCalledTimes(1))
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('shows the error of the update when editing, not the create error', () => {
    setup(
      { error: new Error('create failed') },
      { error: new Error('update failed') },
    )
    render(
      <TodoEditor
        todo={task}
        busy={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    )
    expect(screen.getByText('update failed')).toBeVisible()
    expect(screen.queryByText('create failed')).not.toBeInTheDocument()
  })

  it('shows the error of the create when adding, not the update error', () => {
    setup(
      { error: new Error('create failed') },
      { error: new Error('update failed') },
    )
    render(
      <TodoEditor
        todo="new"
        busy={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    )
    expect(screen.getByText('create failed')).toBeVisible()
    expect(screen.queryByText('update failed')).not.toBeInTheDocument()
  })

  it('locks the editor while its own mutation is running', () => {
    setup({}, { isPending: true })
    render(
      <TodoEditor
        todo={task}
        busy={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
  })

  it('ignores a running create mutation when editing', () => {
    setup({ isPending: true }, {})
    render(
      <TodoEditor
        todo={task}
        busy={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Save task' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled()
  })

  it('locks the form and the drawer when the parent is busy', () => {
    setup()
    render(<TodoEditor todo={task} busy onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
  })

  it('closes from Cancel and from Close', async () => {
    const user = userEvent.setup()
    setup()
    const onClose = vi.fn()
    render(
      <TodoEditor
        todo={task}
        busy={false}
        onClose={onClose}
        onSaved={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
