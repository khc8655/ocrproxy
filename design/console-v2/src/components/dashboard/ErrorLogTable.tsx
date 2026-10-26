import { useMemo, useState } from 'react'
import { Inbox } from 'lucide-react'
import type { ErrorLog } from '@/types'
import {
  Badge,
  Button,
  EmptyState,
  SectionCard,
  Segmented,
} from '@/components/ui/primitives'
import { useToast } from '@/components/ui/toast-context'
import { logCategoryTone } from '@/components/common/semantics'

type LogFilter = 'all' | 'agent' | 'kb'

function statusBadge(status: number) {
  if (status === 429) return <Badge tone="warning">429 限流</Badge>
  if (status === 401) return <Badge tone="danger">401 鉴权</Badge>
  if (status === 504) return <Badge tone="warning">超时</Badge>
  if (status >= 500) return <Badge tone="danger">{status} 异常</Badge>
  return <Badge tone="neutral">{status}</Badge>
}

export function ErrorLogTable({ logs }: { logs: ErrorLog[] }) {
  const [filter, setFilter] = useState<LogFilter>('all')
  const [cleared, setCleared] = useState(false)
  const { toast } = useToast()

  const rows = useMemo(() => {
    if (cleared) return []
    if (filter === 'all') return logs
    return logs.filter((log) => log.category.toLowerCase() === filter)
  }, [logs, filter, cleared])

  return (
    <SectionCard
      title="最近错误日志"
      description="上游调用失败与自动切换记录"
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Segmented
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { label: '全部', value: 'all' },
              { label: '仅 Agent', value: 'agent' },
              { label: '仅 KB', value: 'kb' },
            ]}
          />
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              setCleared(true)
              toast({ title: '已清空错误日志', description: '新的错误记录仍会继续采集' })
            }}
            disabled={cleared}
          >
            清空错误日志
          </Button>
        </div>
      }
      contentClassName="p-0"
    >
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr className="bg-secondary/50 text-[11px] text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">时间</th>
                <th className="px-3 py-2.5 font-medium">分类</th>
                <th className="px-3 py-2.5 font-medium">模型 / 类型</th>
                <th className="px-3 py-2.5 font-medium">供应商</th>
                <th className="px-3 py-2.5 font-medium">Key 别名</th>
                <th className="px-3 py-2.5 font-medium">状态</th>
                <th className="px-5 py-2.5 font-medium">错误详情</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((log) => (
                <tr
                  key={log.id}
                  className="border-t border-border text-xs transition-colors hover:bg-secondary/40"
                >
                  <td className="whitespace-nowrap px-5 py-3 font-mono text-[11px] text-muted-foreground">
                    {log.time}
                  </td>
                  <td className="px-3 py-3">
                    <Badge tone={logCategoryTone[log.category]}>{log.category}</Badge>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 font-mono text-[11px] font-medium text-foreground">
                    {log.model}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-[11px] text-secondary-foreground">
                    {log.provider}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 font-mono text-[11px] text-muted-foreground">
                    {log.keyLabel}
                  </td>
                  <td className="px-3 py-3">{statusBadge(log.status)}</td>
                  <td
                    className="max-w-[300px] truncate px-5 py-3 text-[11px] text-muted-foreground"
                    title={log.detail}
                  >
                    {log.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="p-5">
          <EmptyState
            icon={<Inbox className="h-5 w-5" />}
            title="暂无错误记录"
            description="上游调用一切正常，或该时间段内的日志已被清空。"
          />
        </div>
      )}
    </SectionCard>
  )
}
