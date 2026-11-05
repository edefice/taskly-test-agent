const DAY_IN_MS = 24 * 60 * 60 * 1000

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_IN_MS)
}

/** Both dates are YYYY-MM-DD, so the result does not depend on the time zone. */
export function dueLabel(dueDate: string | null, today: string): string {
  if (dueDate === null) return 'No due date'
  const days = dayNumber(dueDate) - dayNumber(today)
  if (Number.isNaN(days)) return 'Invalid due date'
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  if (days === -1) return 'Overdue by 1 day'
  return days > 0 ? `Due in ${days} days` : `Overdue by ${-days} days`
}
