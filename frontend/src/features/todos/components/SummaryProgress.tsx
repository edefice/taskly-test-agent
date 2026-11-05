import { Text } from '../../../design-system'

export function SummaryProgress({ percent }: { percent: number }) {
  return (
    <div className="row compact">
      <progress aria-label="Tasks completed" max={100} value={percent} />
      <Text muted>{percent === 100 ? 'All done' : `${percent}% complete`}</Text>
    </div>
  )
}
