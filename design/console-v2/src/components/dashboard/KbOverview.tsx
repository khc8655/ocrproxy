import type { KbStat, OverviewStats } from '@/types'
import { Badge, SectionCard } from '@/components/ui/primitives'
import { formatNumber } from '@/lib/utils'

const KB_ITEMS: { key: keyof OverviewStats['kb']; label: string }[] = [
  { key: 'chat', label: '知识库对话' },
  { key: 'embedding', label: '向量 Embedding' },
  { key: 'reranker', label: '重排 Rerank' },
  { key: 'ocr', label: 'OCR 识别' },
]

function KbCell({ label, stat }: { label: string; stat: KbStat }) {
  const rate = stat.count ? ((stat.success / stat.count) * 100).toFixed(1) : '0.0'
  return (
    <div className="px-4 py-3.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="tnum mt-1 font-display text-lg font-semibold text-foreground">
        {formatNumber(stat.count)}
      </p>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
        成功 <b className="font-medium text-secondary-foreground">{formatNumber(stat.success)}</b>
        <span className="mx-1 text-border">·</span>
        异常 <b className="font-medium text-secondary-foreground">{stat.errors}</b>
        <span className="mx-1 text-border">·</span>
        成功率 <b className="font-medium text-secondary-foreground">{rate}%</b>
      </p>
    </div>
  )
}

export function KbOverview({ stats }: { stats: OverviewStats }) {
  return (
    <SectionCard
      title="知识库入库总览"
      actions={<Badge tone="neutral">虚拟别名</Badge>}
      contentClassName="p-0"
    >
      <div className="grid divide-y divide-border sm:grid-cols-2 sm:divide-x lg:grid-cols-4 lg:divide-y-0">
        {KB_ITEMS.map((item) => (
          <KbCell key={item.key} label={item.label} stat={stats.kb[item.key]} />
        ))}
      </div>
    </SectionCard>
  )
}
