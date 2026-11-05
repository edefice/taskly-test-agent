import { expect, it } from 'vitest';
import { summarizeTodos } from '../src/features/todos/summary.ts';
import { todo } from './fixture.ts';

const make = (completed: boolean, due_date: string | null) => ({ ...todo, completed, due_date });

it('summarizes an empty list as zeros', () => {
  expect(summarizeTodos([], '2026-10-15')).toEqual({ total: 0, completed: 0, active: 0, overdue: 0, percent_complete: 0 });
});

it('counts completed and active tasks and rounds the percentage', () => {
  const result = summarizeTodos([make(true, null), make(false, null), make(false, null)], '2026-10-15');
  expect(result).toEqual({ total: 3, completed: 1, active: 2, overdue: 0, percent_complete: 33 });
});

it('counts only active tasks due before today as overdue', () => {
  const result = summarizeTodos(
    [make(false, '2026-10-14'), make(false, '2026-10-15'), make(false, '2026-10-16'), make(true, '2026-10-01'), make(false, null)],
    '2026-10-15',
  );
  expect(result.overdue).toBe(1);
});

it('does not count completed tasks with past due dates as overdue', () => {
  const result = summarizeTodos([make(true, '2026-10-01'), make(true, '2026-10-02')], '2026-10-15');
  expect(result.overdue).toBe(0);
});
