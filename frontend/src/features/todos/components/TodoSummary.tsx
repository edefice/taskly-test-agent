import { Card } from '../../../design-system'
import { useTodoSummaryQuery } from '../hooks/useTodoSummaryQuery'
import { SummaryProgress } from './SummaryProgress'
import { SummaryStat } from './SummaryStat'

export function TodoSummary({ revision }: { revision: number }) {
  const { data: summary } = useTodoSummaryQuery(revision)
  // The summary is extra. The page already explains a failed load and an empty list.
  if (!summary || summary.total === 0) return null

  return (
    <Card>
      <div className="row spread">
        <SummaryStat label="Total" value={summary.total} />
        <SummaryStat label="Active" value={summary.active} />
        <SummaryStat
          label="Overdue"
          value={summary.overdue}
          warning={summary.overdue > 0}
        />
      </div>
      <SummaryProgress percent={summary.percent_complete} />
    </Card>
  )
}
