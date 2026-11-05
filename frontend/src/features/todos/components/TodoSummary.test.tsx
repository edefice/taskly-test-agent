import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { Badge } from '../../../design-system'
import { useTodoSummaryQuery } from '../hooks/useTodoSummaryQuery'
import type { TodoSummary as Summary } from '../types'
import { TodoSummary } from './TodoSummary'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))
vi.mock('../hooks/useTodoSummaryQuery', () => ({
  useTodoSummaryQuery: vi.fn(),
}))

beforeEach(() => vi.clearAllMocks())

function show(data: Summary | undefined, revision = 1) {
  vi.mocked(useTodoSummaryQuery).mockReturnValue({
    data,
  } as unknown as ReturnType<typeof useTodoSummaryQuery>)
  return render(<TodoSummary revision={revision} />)
}

const summary: Summary = {
  total: 5,
  completed: 2,
  active: 3,
  overdue: 0,
  percent_complete: 40,
}

const warningFlags = () =>
  vi.mocked(Badge).mock.calls.map(([props]) => [props.children, props.variant])

it('renders nothing while there is no summary', () => {
  const { container } = show(undefined)
  expect(container).toBeEmptyDOMElement()
})

it('renders nothing when there are no tasks', () => {
  const { container } = show({ ...summary, total: 0, active: 0 })
  expect(container).toBeEmptyDOMElement()
})

it('shows the counts and progress', () => {
  show(summary)
  expect(screen.getByText('Total')).toBeVisible()
  expect(screen.getByText('5')).toBeVisible()
  expect(screen.getByText('3')).toBeVisible()
  expect(screen.getByText('40% complete')).toBeVisible()
})

it('passes the revision to the query', () => {
  show(summary, 7)
  expect(useTodoSummaryQuery).toHaveBeenCalledWith(7)
})

it('does not warn when nothing is overdue', () => {
  show(summary)
  expect(warningFlags()).toEqual([
    [5, 'neutral'],
    [3, 'neutral'],
    [0, 'neutral'],
  ])
})

it('warns about overdue tasks', () => {
  show({ ...summary, overdue: 2 })
  expect(warningFlags()).toEqual([
    [5, 'neutral'],
    [3, 'neutral'],
    [2, 'warning'],
  ])
})
