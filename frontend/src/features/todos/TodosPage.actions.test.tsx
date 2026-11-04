import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { todoFixture } from '../../test/todoFixture'
import { useNotice } from '../../hooks/useNotice'
import { useTodoFilters } from './hooks/useTodoFilters'
import { useTodosBusy } from './hooks/useTodosBusy'
import { useTodosQuery } from './hooks/useTodosQuery'
import { useUpdateTodoMutation } from './hooks/useUpdateTodoMutation'
import type { Todo } from './types'
import { TodosPage } from './TodosPage'

vi.mock('../../design-system', () => import('../../design-system/mocks'))
vi.mock('../../hooks/useNotice', () => ({ useNotice: vi.fn() }))
vi.mock('./hooks/useTodoFilters', () => ({ useTodoFilters: vi.fn() }))
vi.mock('./hooks/useTodosBusy', () => ({ useTodosBusy: vi.fn() }))
vi.mock('./hooks/useTodosQuery', () => ({ useTodosQuery: vi.fn() }))
vi.mock('./hooks/useUpdateTodoMutation', () => ({
  useUpdateTodoMutation: vi.fn(),
}))
vi.mock('./components/TodosHeader', () => ({
  TodosHeader: (props: { disabled: boolean; onCreate: () => void }) => (
    <button disabled={props.disabled} onClick={props.onCreate}>
      New task
    </button>
  ),
}))
vi.mock('./components/TodoFilters', () => ({ TodoFilters: () => null }))
vi.mock('./components/TodoList', () => ({
  TodoList: (props: {
    todos: Todo[]
    hasTodos: boolean
    loading: boolean
    failed: boolean
    busy: boolean
    onCreate: () => void
    onToggle: (todo: Todo) => void
    onEdit: (todo: Todo) => void
    onDelete: (todo: Todo) => void
  }) => (
    <section>
      <p>
        visible:{props.todos.map((t) => t.title).join(',')};hasTodos:
        {String(props.hasTodos)};loading:{String(props.loading)};failed:
        {String(props.failed)};busy:{String(props.busy)}
      </p>
      <button onClick={props.onCreate}>list create</button>
      {props.todos.map((t) => (
        <div key={t.id}>
          <button onClick={() => props.onToggle(t)}>toggle {t.title}</button>
          <button onClick={() => props.onEdit(t)}>edit {t.title}</button>
          <button onClick={() => props.onDelete(t)}>delete {t.title}</button>
        </div>
      ))}
    </section>
  ),
}))
vi.mock('./components/TodoEditor', () => ({
  TodoEditor: (props: {
    todo: Todo | 'new'
    onClose: () => void
    onSaved: (notice: string) => void
  }) => (
    <div>
      <p>editor:{props.todo === 'new' ? 'new' : props.todo.title}</p>
      <button onClick={props.onClose}>close editor</button>
      <button onClick={() => props.onSaved('Task saved.')}>save editor</button>
    </div>
  ),
}))
vi.mock('./components/DeleteTodoDialog', () => ({
  DeleteTodoDialog: (props: {
    todo: Todo
    onClose: () => void
    onDeleted: () => void
  }) => (
    <div>
      <p>deleting:{props.todo.title}</p>
      <button onClick={props.onClose}>close dialog</button>
      <button onClick={props.onDeleted}>confirm delete</button>
    </div>
  ),
}))
vi.mock('../../components/SuccessNotice', () => ({
  SuccessNotice: (props: { message: string }) => <p>notice:{props.message}</p>,
}))

const other: Todo = { ...todoFixture, id: 8, title: 'Other task' }
const notify = vi.fn()
const mutateAsync = vi.fn()
const reset = vi.fn()
const refetch = vi.fn()

interface Options {
  data?: Todo[] | undefined
  visible?: Todo[]
  isPending?: boolean
  isFetching?: boolean
  isError?: boolean
  queryError?: Error | null
  mutationError?: Error | null
  busy?: boolean
  message?: string
}

function setup(options: Options = {}) {
  const all = 'data' in options ? options.data : [todoFixture]
  vi.mocked(useTodosQuery).mockReturnValue({
    data: all,
    isPending: options.isPending ?? false,
    isFetching: options.isFetching ?? false,
    isError: options.isError ?? false,
    error: options.queryError ?? null,
    refetch,
  } as unknown as ReturnType<typeof useTodosQuery>)
  vi.mocked(useUpdateTodoMutation).mockReturnValue({
    error: options.mutationError ?? null,
    reset,
    mutateAsync,
  } as unknown as ReturnType<typeof useUpdateTodoMutation>)
  vi.mocked(useTodosBusy).mockReturnValue(options.busy ?? false)
  vi.mocked(useNotice).mockReturnValue({
    message: options.message ?? '',
    notify,
  })
  vi.mocked(useTodoFilters).mockReturnValue({
    filter: 'all',
    search: '',
    sort: 'newest',
    visible: options.visible ?? all ?? [],
    setFilter: vi.fn(),
    setSearch: vi.fn(),
    setSort: vi.fn(),
  })
  return render(<TodosPage />)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('props passed to children', () => {
  it('lists the filtered todos, not all todos', () => {
    setup({ data: [todoFixture, other], visible: [other] })
    expect(screen.getByText(/visible:Other task;/)).toBeVisible()
    expect(screen.getByText(/hasTodos:true/)).toBeVisible()
  })

  it('tells the list there are no todos when the data is undefined', () => {
    setup({ data: undefined, isPending: true })
    expect(
      screen.getByText(/visible:;hasTodos:false;loading:true/),
    ).toBeVisible()
  })

  it('tells the list there are no todos for an empty list', () => {
    setup({ data: [] })
    expect(screen.getByText(/hasTodos:false/)).toBeVisible()
  })

  it('passes failed and busy states to the list', () => {
    setup({ isError: true, busy: true, queryError: new Error('x') })
    expect(screen.getByText(/failed:true;busy:true/)).toBeVisible()
  })

  it('enables the header when idle', () => {
    setup()
    expect(screen.getByRole('button', { name: 'New task' })).toBeEnabled()
  })

  it('disables the header while the query is pending', () => {
    setup({ isPending: true })
    expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled()
  })

  it('disables the header while a request is busy', () => {
    setup({ busy: true })
    expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled()
  })
})

describe('error alert', () => {
  it('shows no alert without an error', () => {
    setup()
    expect(screen.queryByTestId('alert')).not.toBeInTheDocument()
  })

  it('shows the mutation error before the query error', () => {
    setup({
      mutationError: new Error('Update failed.'),
      queryError: new Error('Load failed.'),
    })
    expect(screen.getByTestId('alert')).toHaveTextContent('Update failed.')
  })

  it('enables Try again when idle', () => {
    setup({ queryError: new Error('Load failed.') })
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('disables Try again while fetching', () => {
    setup({ queryError: new Error('Load failed.'), isFetching: true })
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled()
  })

  it('disables Try again while a request is busy', () => {
    setup({ queryError: new Error('Load failed.'), busy: true })
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled()
  })
})

describe('toggling', () => {
  it('completes an active task and announces it', async () => {
    const user = userEvent.setup()
    mutateAsync.mockResolvedValue({ ...todoFixture, completed: true })
    setup()
    await user.click(screen.getByRole('button', { name: /toggle/ }))
    expect(mutateAsync).toHaveBeenCalledWith({
      id: todoFixture.id,
      input: { completed: true },
    })
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Another task complete. Well done!'),
    )
  })

  it('un-completes a completed task and announces it', async () => {
    const user = userEvent.setup()
    const done = { ...todoFixture, completed: true }
    mutateAsync.mockResolvedValue({ ...done, completed: false })
    setup({ data: [done] })
    await user.click(screen.getByRole('button', { name: /toggle/ }))
    expect(mutateAsync).toHaveBeenCalledWith({
      id: done.id,
      input: { completed: false },
    })
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Task marked as active.'),
    )
  })

  it('does nothing while busy', async () => {
    const user = userEvent.setup()
    setup({ busy: true })
    await user.click(screen.getByRole('button', { name: /toggle/ }))
    expect(mutateAsync).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('shows no notice when the request fails', async () => {
    const user = userEvent.setup()
    mutateAsync.mockRejectedValue(new Error('down'))
    setup()
    await user.click(screen.getByRole('button', { name: /toggle/ }))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('editor and dialog', () => {
  it('opens the editor for a new task from the header', async () => {
    const user = userEvent.setup()
    setup()
    expect(screen.queryByText(/editor:/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New task' }))
    expect(screen.getByText('editor:new')).toBeVisible()
  })

  it('opens the editor for a new task from the empty list', async () => {
    const user = userEvent.setup()
    setup({ data: [] })
    await user.click(screen.getByRole('button', { name: 'list create' }))
    expect(screen.getByText('editor:new')).toBeVisible()
  })

  it('opens the editor for an existing task', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: /^edit/ }))
    expect(screen.getByText(`editor:${todoFixture.title}`)).toBeVisible()
  })

  it('closes the editor without a notice', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: 'New task' }))
    await user.click(screen.getByRole('button', { name: 'close editor' }))
    expect(screen.queryByText(/editor:/)).not.toBeInTheDocument()
    expect(notify).not.toHaveBeenCalled()
  })

  it('closes the editor and shows the notice after saving', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: 'New task' }))
    await user.click(screen.getByRole('button', { name: 'save editor' }))
    expect(screen.queryByText(/editor:/)).not.toBeInTheDocument()
    expect(notify).toHaveBeenCalledWith('Task saved.')
  })

  it('opens and closes the delete dialog', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: /^delete/ }))
    expect(screen.getByText(`deleting:${todoFixture.title}`)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'close dialog' }))
    expect(screen.queryByText(/deleting:/)).not.toBeInTheDocument()
    expect(notify).not.toHaveBeenCalled()
  })

  it('closes the dialog and announces the deletion', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: /^delete/ }))
    await user.click(screen.getByRole('button', { name: 'confirm delete' }))
    expect(screen.queryByText(/deleting:/)).not.toBeInTheDocument()
    expect(notify).toHaveBeenCalledWith('Task deleted.')
  })

  it('renders the current notice message', () => {
    setup({ message: 'Hello there' })
    expect(screen.getByText('notice:Hello there')).toBeVisible()
  })
})
