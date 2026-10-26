import type { ReactNode } from 'react'
import type { OverviewStats, Provider } from '@/types'
import { Badge, SectionCard } from '@/components/ui/primitives'
import { formatNumber, formatTokens } from '@/lib/utils'

function Stat({
  label,
  value,
  unit,
  children,
  tone,
}: {
  label: string
  value: string
  unit?: string
  children: ReactNode
  tone?: 'primary' | 'warning' | 'default'
}) {
  return (
    <div className="px-4 py-3.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={
          tone === 'primary'
            ? 'tnum mt-1 font-display text-xl font-semibold text-primary'
            : tone === 'warning'
              ? 'tnum mt-1 font-display text-xl font-semibold text-warning'
              : 'tnum mt-1 font-display text-xl font-semibold text-foreground'
        }
      >
        {value}
        {unit ? <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span> : null}
      </p>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{children}</p>
    </div>
  )
}

export function AgentOverview({
  stats,
  snapshotProviders,
}: {
  stats: OverviewStats
  snapshotProviders?: Provider[]
}) {
  if (snapshotProviders) {
    const keys = snapshotProviders.flatMap((provider) => provider.keys)
    const available = keys.filter((key) => key.health !== 'rate_limited' && key.health !== 'error' && key.health !== 'quota')
    const limited = keys.filter((key) => key.health === 'rate_limited')
    const failed = keys.filter((key) => key.health === 'error' || key.health === 'quota')
    const latencies = available
      .map((key) => key.latencyMs)
      .filter((value): value is number => typeof value === 'number' && value > 0)
    const avgLatency = latencies.length
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : 0

    return (
      <SectionCard
        title="Agent 对话总览"
        actions={<Badge tone="info">当前快照</Badge>}
        contentClassName="p-0"
      >
        <div className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <Stat label="可用 Key" value={String(available.length)} tone="primary">
            共 <b className="font-medium text-secondary-foreground">{keys.length}</b> 个 Key
            <span className="mx-1 text-border">·</span>
            覆盖 <b className="font-medium text-secondary-foreground">{snapshotProviders.length}</b> 家供应商
          </Stat>
          <Stat label="限流 Key" value={String(limited.length)} tone={limited.length ? 'warning' : 'default'}>
            429 限流后按冷却策略自动恢复
          </Stat>
          <Stat label="异常与欠费" value={String(failed.length)} tone={failed.length ? 'warning' : 'default'}>
            平均响应 <b className="font-medium text-secondary-foreground">{avgLatency ? `${formatNumber(avgLatency)} ms` : '—'}</b>
          </Stat>
        </div>
        <div className="border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
          EdgeOne 边缘版不做自然日累计，以上按每个 Key 最近一次调用与冷却状态计算。
        </div>
      </SectionCard>
    )
  }

  const totalRequests = stats.modelShare.reduce((sum, item) => sum + item.requests, 0)
  const topModels = [...stats.modelShare]
    .sort((a, b) => b.requests - a.requests)
    .filter((item) => item.name !== '其他模型')
    .slice(0, 3)
  const failTone =
    stats.requests > 0 && stats.failures / stats.requests > 0.05 ? 'warning' : 'default'

  return (
    <SectionCard
      title="Agent 对话总览"
      actions={<Badge tone="success">今日累计</Badge>}
      contentClassName="p-0"
    >
      <div className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Stat label="今日 Token 总量" value={formatTokens(stats.tokensIn + stats.tokensOut)} tone="primary">
          输入 <b className="font-medium text-secondary-foreground">{formatTokens(stats.tokensIn)}</b>
          <span className="mx-1 text-border">·</span>
          输出 <b className="font-medium text-secondary-foreground">{formatTokens(stats.tokensOut)}</b>
        </Stat>
        <Stat label="平均首字延迟" value={formatNumber(stats.ttftMs)} unit="ms">
          平均总耗时 <b className="font-medium text-secondary-foreground">{formatNumber(stats.totalMsAvg)} ms</b>
        </Stat>
        <Stat label="失败请求" value={formatNumber(stats.failures)} tone={failTone}>
          共 <b className="font-medium text-secondary-foreground">{formatNumber(stats.requests)}</b> 次
          <span className="mx-1 text-border">·</span>
          切 Key 救回 <b className="font-medium text-secondary-foreground">{stats.failovers}</b> 次
        </Stat>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        <span className="text-[11px] font-medium text-muted-foreground">热门模型 Top 3</span>
        {topModels.map((model, index) => {
          const percent = totalRequests ? Math.round((model.requests / totalRequests) * 100) : 0
          return (
            <span
              key={model.name}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-[11px]"
            >
              <span className="font-semibold text-muted-foreground">#{index + 1}</span>
              <span className="font-mono font-medium text-foreground">{model.name}</span>
              <span className="tnum text-muted-foreground">
                {formatNumber(model.requests)} 次 · {percent}%
              </span>
            </span>
          )
        })}
      </div>
    </SectionCard>
  )
}
