import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { Badge } from '../../../design-system'
import { SummaryStat } from './SummaryStat'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

beforeEach(() => vi.clearAllMocks())

const variants = () =>
  vi.mocked(Badge).mock.calls.map(([props]) => props.variant)

it('shows the label and the value', () => {
  render(<SummaryStat label="Active" value={4} />)
  expect(screen.getByText('Active')).toBeVisible()
  expect(screen.getByText('4')).toBeVisible()
})

it('uses a neutral badge by default', () => {
  render(<SummaryStat label="Active" value={4} />)
  expect(variants()).toEqual(['neutral'])
})

it('uses a warning badge when flagged', () => {
  render(<SummaryStat label="Overdue" value={2} warning />)
  expect(variants()).toEqual(['warning'])
})
