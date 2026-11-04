import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import type { Todo } from '../types'
import { TodoList } from './TodoList'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

const second: Todo = { ...todoFixture, id: 8, title: 'Write the report' }

const onCreate = vi.fn()
const onToggle = vi.fn()
const onEdit = vi.fn()
const onDelete = vi.fn()

function renderList(overrides: Partial<Parameters<typeof TodoList>[0]> = {}) {
  return render(
    <TodoList
      todos={[todoFixture, second]}
      hasTodos
      loading={false}
      failed={false}
      busy={false}
      onCreate={onCreate}
      onToggle={onToggle}
      onEdit={onEdit}
      onDelete={onDelete}
      {...overrides}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('calls each handler with the task whose button was used', async () => {
  const user = userEvent.setup()
  renderList()
  await user.click(
    screen.getByRole('checkbox', { name: `Complete: ${second.title}` }),
  )
  expect(onToggle).toHaveBeenCalledExactlyOnceWith(second)
  await user.click(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  )
  expect(onEdit).toHaveBeenCalledExactlyOnceWith(todoFixture)
  await user.click(
    screen.getByRole('button', { name: `Delete: ${second.title}` }),
  )
  expect(onDelete).toHaveBeenCalledExactlyOnceWith(second)
  expect(onToggle).toHaveBeenCalledTimes(1)
  expect(onEdit).toHaveBeenCalledTimes(1)
  expect(onDelete).toHaveBeenCalledTimes(1)
})

it('disables the task controls while busy', () => {
  renderList({ busy: true })
  expect(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  ).toBeDisabled()
  expect(
    screen.getByRole('button', { name: `Delete: ${second.title}` }),
  ).toBeDisabled()
  expect(
    screen.getByRole('checkbox', { name: `Complete: ${todoFixture.title}` }),
  ).toBeDisabled()
})

it('enables the task controls when not busy', () => {
  renderList()
  expect(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  ).toBeEnabled()
})

it('offers to add the first task when there are no tasks at all', async () => {
  const user = userEvent.setup()
  renderList({ todos: [], hasTodos: false })
  expect(
    screen.getByRole('heading', { name: 'Add your first task' }),
  ).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Add your first task' }))
  expect(onCreate).toHaveBeenCalledTimes(1)
})

it('disables the add button while busy', () => {
  renderList({ todos: [], hasTodos: false, busy: true })
  expect(
    screen.getByRole('button', { name: 'Add your first task' }),
  ).toBeDisabled()
})

it('says no tasks match when a filter hides every task', () => {
  renderList({ todos: [], hasTodos: true })
  expect(
    screen.getByRole('heading', { name: 'No matching tasks' }),
  ).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Add your first task' }),
  ).not.toBeInTheDocument()
})

it('shows an unavailable message when loading failed and nothing is cached', () => {
  renderList({ todos: [], hasTodos: false, failed: true })
  expect(
    screen.getByRole('heading', {
      name: 'The task list is temporarily unavailable',
    }),
  ).toBeVisible()
})

it('keeps showing tasks when a refresh failed but tasks exist', () => {
  renderList({ failed: true })
  expect(screen.getByRole('heading', { name: todoFixture.title })).toBeVisible()
  expect(
    screen.queryByText('The task list is temporarily unavailable'),
  ).not.toBeInTheDocument()
})
