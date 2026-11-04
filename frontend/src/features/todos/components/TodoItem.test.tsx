import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { todoFixture } from '../../../test/todoFixture'
import { TodoItem } from './TodoItem'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

afterEach(() => {
  vi.useRealTimers()
})

function renderItem(
  todo = todoFixture,
  props: Partial<{
    busy: boolean
    onToggle: () => void
    onEdit: () => void
    onDelete: () => void
  }> = {},
) {
  return render(
    <TodoItem
      todo={todo}
      busy={false}
      onEdit={vi.fn()}
      onToggle={vi.fn()}
      onDelete={vi.fn()}
      {...props}
    />,
  )
}

it('shows the description and the id of a task', () => {
  renderItem({ ...todoFixture, description: 'Slides and notes' })
  expect(screen.getByText('Slides and notes')).toBeVisible()
  expect(screen.getByText('#7')).toBeVisible()
})

it('shows no description text when the description is empty', () => {
  const { container } = renderItem({ ...todoFixture, description: '' })
  expect(container.querySelector('p')).toBeNull()
  expect(screen.getByText('#7')).toBeVisible()
})

it('shows a completed task and forwards toggle and delete requests', async () => {
  const user = userEvent.setup()
  const onToggle = vi.fn()
  const onDelete = vi.fn()
  renderItem({ ...todoFixture, completed: true }, { onToggle, onDelete })
  expect(screen.getByText('Completed')).toBeVisible()
  expect(screen.queryByText('To do')).not.toBeInTheDocument()
  const checkbox = screen.getByRole('checkbox', {
    name: `Mark as active: ${todoFixture.title}`,
  })
  expect(checkbox).toBeChecked()
  await user.click(checkbox)
  expect(onToggle).toHaveBeenCalledTimes(1)
  await user.click(
    screen.getByRole('button', { name: `Delete: ${todoFixture.title}` }),
  )
  expect(onDelete).toHaveBeenCalledTimes(1)
})

it('disables every action while busy', () => {
  renderItem(todoFixture, { busy: true })
  expect(screen.getByRole('checkbox')).toBeDisabled()
  expect(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  ).toBeDisabled()
  expect(
    screen.getByRole('button', { name: `Delete: ${todoFixture.title}` }),
  ).toBeDisabled()
})

it('marks an open task with a past due date as overdue', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 5, 15, 12))
  renderItem({ ...todoFixture, due_date: '2026-06-14' })
  expect(screen.getByText(/14 Jun 2026/)).toHaveTextContent('overdue')
})

it('does not mark a due date of today, or a completed task, as overdue', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 5, 15, 12))
  const { unmount } = renderItem({ ...todoFixture, due_date: '2026-06-15' })
  expect(screen.getByText(/15 Jun 2026/)).not.toHaveTextContent('overdue')
  unmount()
  renderItem({ ...todoFixture, due_date: '2026-06-14', completed: true })
  expect(screen.getByText(/14 Jun 2026/)).not.toHaveTextContent('overdue')
})

it('shows an active task and forwards edit requests', async () => {
  const user = userEvent.setup()
  const onEdit = vi.fn()
  const onToggle = vi.fn()
  const onDelete = vi.fn()
  render(
    <TodoItem
      todo={todoFixture}
      busy={false}
      onEdit={onEdit}
      onToggle={onToggle}
      onDelete={onDelete}
    />,
  )
  expect(screen.getByRole('heading', { name: todoFixture.title })).toBeVisible()
  expect(screen.getByText('To do')).toBeVisible()
  expect(screen.getByText('Medium')).toBeVisible()
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  await user.click(
    screen.getByRole('button', { name: `Edit: ${todoFixture.title}` }),
  )
  expect(onEdit).toHaveBeenCalledTimes(1)
  expect(onToggle).not.toHaveBeenCalled()
  expect(onDelete).not.toHaveBeenCalled()
})
