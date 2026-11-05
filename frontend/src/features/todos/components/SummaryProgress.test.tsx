import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SummaryProgress } from './SummaryProgress'

vi.mock('../../../design-system', () => import('../../../design-system/mocks'))

it('shows the percentage while tasks remain', () => {
  render(<SummaryProgress percent={40} />)
  expect(screen.getByText('40% complete')).toBeVisible()
  expect(
    screen.getByRole('progressbar', { name: 'Tasks completed' }),
  ).toHaveAttribute('value', '40')
})

it('says all done at 100 percent', () => {
  render(<SummaryProgress percent={100} />)
  expect(screen.getByText('All done')).toBeVisible()
  expect(screen.queryByText('100% complete')).not.toBeInTheDocument()
})
