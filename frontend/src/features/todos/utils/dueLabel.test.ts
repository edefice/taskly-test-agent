import { expect, it } from 'vitest'
import { dueLabel } from './dueLabel'

const today = '2026-06-15'

it('says there is no due date when it is null', () => {
  expect(dueLabel(null, today)).toBe('No due date')
})

it('says due today for the same day', () => {
  expect(dueLabel('2026-06-15', today)).toBe('Due today')
})

it('says due tomorrow for the next day', () => {
  expect(dueLabel('2026-06-16', today)).toBe('Due tomorrow')
})

it('says overdue by 1 day for yesterday', () => {
  expect(dueLabel('2026-06-14', today)).toBe('Overdue by 1 day')
})

it('counts days ahead in the plural', () => {
  expect(dueLabel('2026-06-18', today)).toBe('Due in 3 days')
})

it('counts days overdue in the plural', () => {
  expect(dueLabel('2026-06-10', today)).toBe('Overdue by 5 days')
})

it('counts across month and leap-year boundaries', () => {
  expect(dueLabel('2028-03-01', '2028-02-28')).toBe('Due in 2 days')
  expect(dueLabel('2026-01-01', '2025-12-31')).toBe('Due tomorrow')
})
