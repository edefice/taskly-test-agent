import { Badge, Text } from '../../../design-system'

export function SummaryStat({
  label,
  value,
  warning = false,
}: {
  label: string
  value: number
  warning?: boolean
}) {
  return (
    <div className="row compact">
      <Text muted>{label}</Text>
      <Badge variant={warning ? 'warning' : 'neutral'}>{value}</Badge>
    </div>
  )
}
