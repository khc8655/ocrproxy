import { Lock } from 'lucide-react'
import type { KeyHealth, KeySource, Protocol } from '@/types'
import { Badge, Dot } from '@/components/ui/primitives'
import { formatLatency } from '@/lib/utils'
import {
  healthLabel,
  healthTone,
  protocolLabels,
  protocolTone,
  sourceLabel,
  sourceTone,
} from '@/components/common/semantics'

export function ProtocolBadges({ protocols }: { protocols: Protocol[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {protocols.map((protocol) => (
        <Badge
          key={protocol}
          tone={protocolTone[protocol]}
          className="font-mono text-[10px]"
        >
          {protocolLabels[protocol]}
        </Badge>
      ))}
    </div>
  )
}

export function SourceBadge({ source }: { source: KeySource }) {
  return (
    <Badge tone={sourceTone[source]} className="text-[10px]">
      {source === 'vault' ? <Lock className="h-3 w-3" /> : null}
      {sourceLabel[source]}
    </Badge>
  )
}

export function HealthBadge({
  health,
  latencyMs,
  showDot = false,
}: {
  health: KeyHealth
  latencyMs?: number | null
  showDot?: boolean
}) {
  const tone = healthTone[health]
  const label = health === 'ok' && latencyMs ? formatLatency(latencyMs) : healthLabel[health]
  return (
    <Badge tone={tone} className="tnum">
      {showDot ? <Dot tone={tone} /> : null}
      {label}
    </Badge>
  )
}
