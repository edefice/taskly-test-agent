import type { Todo } from './types.js';

export interface TodoSummary {
  total: number;
  completed: number;
  active: number;
  overdue: number;
  percent_complete: number;
}

/** @param today The current date as YYYY-MM-DD, the format of a due date, so that the two compare as text. */
export function summarizeTodos(todos: Todo[], today: string): TodoSummary {
  const total = todos.length;
  const completed = todos.filter((todo) => todo.completed).length;
  const overdue = todos.filter((todo) => !todo.completed && todo.due_date !== null && todo.due_date < today).length;
  return {
    total,
    completed,
    active: total - completed,
    overdue,
    percent_complete: total === 0 ? 0 : Math.floor((completed / total) * 100),
  };
}
