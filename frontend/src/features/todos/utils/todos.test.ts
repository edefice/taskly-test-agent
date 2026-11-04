import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatDate, isOverdue, selectTodos, validateTodo } from './todos'
import type { Todo, TodoInput } from '../types'

const base: Todo = {
  id: 1,
  title: 'Sprint plan',
  description: '',
  priority: 'medium',
  completed: false,
  due_date: null,
  created_at: '2026-10-01T12:00:00Z',
  updated_at: '2026-10-01T12:00:00Z',
}

const validInput: TodoInput = {
  title: 'Write tests',
  description: '',
  priority: 'low',
  due_date: null,
  completed: false,
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('selectTodos', () => {
  it('combines status with a case-insensitive search in the description', () => {
    const matching = { ...base, description: 'Discuss the API' }
    const todos = [
      matching,
      { ...matching, id: 2, completed: true },
      { ...base, id: 3 },
    ]
    expect(selectTodos(todos, 'active', ' api ', 'newest')).toEqual([matching])
  })

  it('sorts by priority without changing the source array', () => {
    const high: Todo = { ...base, id: 2, priority: 'high' }
    const todos = [base, high]
    expect(selectTodos(todos, 'all', '', 'priority')).toEqual([high, base])
    expect(todos).toEqual([base, high])
  })

  it('shows only completed tasks for the completed filter', () => {
    const done = { ...base, id: 2, completed: true }
    expect(selectTodos([base, done], 'completed', '', 'newest')).toEqual([done])
  })

  it('puts the newer task first when sorting by newest', () => {
    const newer = { ...base, id: 2, created_at: '2026-10-02T12:00:00Z' }
    expect(selectTodos([base, newer], 'all', '', 'newest')).toEqual([
      newer,
      base,
    ])
  })

  it('puts the higher id first for equal priorities', () => {
    const other = { ...base, id: 5 }
    expect(selectTodos([base, other], 'all', '', 'priority')).toEqual([
      other,
      base,
    ])
  })

  it('sorts by earliest due date, with undated tasks last', () => {
    const soon = { ...base, id: 2, due_date: '2026-11-01' }
    const later = { ...base, id: 3, due_date: '2026-12-01' }
    expect(selectTodos([base, later, soon], 'all', '', 'due')).toEqual([
      soon,
      later,
      base,
    ])
  })

  it('puts the higher id first for equal due dates', () => {
    const a = { ...base, id: 2, due_date: '2026-11-01' }
    const b = { ...base, id: 7, due_date: '2026-11-01' }
    expect(selectTodos([a, b], 'all', '', 'due')).toEqual([b, a])
  })

  it('puts the higher id first for equal creation times', () => {
    const other = { ...base, id: 9 }
    expect(selectTodos([base, other], 'all', '', 'newest')).toEqual([
      other,
      base,
    ])
  })
})

describe('validateTodo', () => {
  it('accepts a valid input', () => {
    expect(validateTodo({ ...validInput, due_date: '2026-02-28' })).toEqual({})
  })

  it('requires a title that is not only spaces', () => {
    expect(validateTodo({ ...validInput, title: '   ' })).toEqual({
      title: 'Enter a task title.',
    })
  })

  it('accepts a title of 120 characters and rejects 121', () => {
    expect(validateTodo({ ...validInput, title: 'a'.repeat(120) })).toEqual({})
    expect(validateTodo({ ...validInput, title: 'a'.repeat(121) })).toEqual({
      title: 'The title must be at most 120 characters.',
    })
  })

  it('does not count surrounding spaces in the title length', () => {
    const title = ` ${'a'.repeat(120)} `
    expect(validateTodo({ ...validInput, title })).toEqual({})
  })

  it('accepts a description of 2000 characters and rejects 2001', () => {
    expect(
      validateTodo({ ...validInput, description: 'a'.repeat(2000) }),
    ).toEqual({})
    expect(
      validateTodo({ ...validInput, description: 'a'.repeat(2001) }),
    ).toEqual({
      description: 'The description must be at most 2000 characters.',
    })
  })

  it('does not count surrounding spaces in the description length', () => {
    const description = ` ${'a'.repeat(2000)} `
    expect(validateTodo({ ...validInput, description })).toEqual({})
  })

  it.each(['2026-02-30', '2026-13-01', 'tomorrow', '2026-1-1', '26-01-01'])(
    'rejects the invalid due date %s',
    (due_date) => {
      expect(validateTodo({ ...validInput, due_date })).toEqual({
        due_date: 'Enter a valid date.',
      })
    },
  )

  it('reports several errors together', () => {
    expect(
      validateTodo({ ...validInput, title: '', due_date: 'nope' }),
    ).toEqual({
      title: 'Enter a task title.',
      due_date: 'Enter a valid date.',
    })
  })
})

describe('isOverdue', () => {
  it('is overdue when the due date is before today and not completed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 15, 12))
    expect(isOverdue({ ...base, due_date: '2026-06-14' })).toBe(true)
  })

  it('is not overdue on the due date itself', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 15, 12))
    expect(isOverdue({ ...base, due_date: '2026-06-15' })).toBe(false)
  })

  it('is not overdue when completed or without a due date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 15, 12))
    expect(
      isOverdue({ ...base, due_date: '2026-06-14', completed: true }),
    ).toBe(false)
    expect(isOverdue(base)).toBe(false)
  })

  it('uses the local date, not the UTC date, east of UTC', () => {
    vi.stubEnv('TZ', 'Pacific/Auckland')
    vi.useFakeTimers()
    // 15 June 08:00 in Auckland, still 14 June in UTC
    vi.setSystemTime(new Date('2026-06-14T20:00:00Z'))
    expect(isOverdue({ ...base, due_date: '2026-06-14' })).toBe(true)
  })

  it('uses the local date, not the UTC date, west of UTC', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    vi.useFakeTimers()
    // 14 June 20:00 in Los Angeles, already 15 June in UTC
    vi.setSystemTime(new Date('2026-06-15T03:00:00Z'))
    expect(isOverdue({ ...base, due_date: '2026-06-14' })).toBe(false)
  })
})

describe('formatDate', () => {
  it('formats a date as day, short month and year', () => {
    expect(formatDate('2026-06-05')).toBe('5 Jun 2026')
  })

  it('shows the same calendar day west of UTC', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    expect(formatDate('2026-06-15')).toBe('15 Jun 2026')
  })

  it('shows the same calendar day east of UTC', () => {
    vi.stubEnv('TZ', 'Pacific/Auckland')
    expect(formatDate('2026-06-15')).toBe('15 Jun 2026')
  })
})
