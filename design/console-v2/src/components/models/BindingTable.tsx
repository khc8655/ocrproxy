import { ArrowLeftRight, Trash2, Zap } from 'lucide-react'
import type { AgentModel, Binding, Provider } from '@/types'
import { Badge, Button } from '@/components/ui/primitives'
import { HealthBadge, SourceBadge } from '@/components/common/badges'
import { OrderInput } from '@/components/models/OrderInput'
import { cn } from '@/lib/utils'

export function BindingTable({
  model,
  providers,
  probing,
  onProbe,
  onSetActive,
  onRemoveBinding,
  onReorder,
}: {
  model: AgentModel
  providers: Provider[]
  probing: Set<string>
  onProbe: (binding: Binding) => void
  onSetActive: (binding: Binding) => void
  onRemoveBinding: (binding: Binding) => void
  onReorder: (from: number, to: number) => void
}) {
  if (!model.bindings.length) {
    return (
      <div className="px-5 py-6 text-center text-xs text-muted-foreground">
        还没有绑定 Key，编辑模型即可添加。
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="bg-secondary/40 text-[11px] text-muted-foreground">
            <th
              className="w-16 px-4 py-2 text-center font-medium"
              title="输入 1 到列表长度的序号调整顺序"
            >
              顺序
            </th>
            <th className="px-3 py-2 font-medium">供应商</th>
            <th className="px-3 py-2 font-medium">Key 别名</th>
            <th className="px-3 py-2 font-medium">来源</th>
            <th className="px-3 py-2 font-medium">状态</th>
            <th className="px-3 py-2 font-medium">最近调用</th>
            <th className="px-5 py-2 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {model.bindings.map((binding, index) => {
            const provider = providers.find((item) => item.id === binding.providerId)
            const key = provider?.keys.find((item) => item.label === binding.keyLabel)
            const bindingId = `${binding.providerId}:${binding.keyLabel}`
            const active = model.activeKey === bindingId
            const probeId = `${model.id}:${binding.providerId}:${binding.keyLabel}`
            const isProbing = probing.has(probeId)

            return (
              <tr
                key={bindingId}
                className={cn(
                  'border-t border-border text-xs transition-colors',
                  active ? 'bg-primary/[0.04]' : 'hover:bg-secondary/30',
                )}
              >
                <td className="w-16 px-4 py-2.5">
                  <div className="flex justify-center">
                    <OrderInput
                      key={index}
                      index={index}
                      total={model.bindings.length}
                      active={active}
                      onCommit={(next) => onReorder(index, next)}
                    />
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <p className="truncate text-xs font-medium text-foreground">
                    {provider?.name ?? binding.providerId}
                  </p>
                </td>
                <td className="px-3 py-2.5">
                  <span className="rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] font-medium text-secondary-foreground">
                    {binding.keyLabel}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  {key ? <SourceBadge source={key.source} /> : <Badge tone="danger">缺失</Badge>}
                </td>
                <td className="px-3 py-2.5">
                  {key ? (
                    <HealthBadge health={key.health} latencyMs={key.latencyMs} showDot />
                  ) : (
                    <Badge tone="danger">Key 不存在</Badge>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-[11px] text-muted-foreground">
                  {key?.lastUsed ?? '—'}
                </td>
                <td className="px-5 py-2.5">
                  <div className="flex items-center justify-end gap-1.5">
                    {active ? (
                      <Badge tone="primary" className="h-7 px-2">
                        使用中
                      </Badge>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onSetActive(binding)}
                        disabled={!key}
                        title="切换为该模型的主力 Key"
                        className="h-7 px-2"
                      >
                        <ArrowLeftRight className="h-3.5 w-3.5" />
                        切换
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onProbe(binding)}
                      loading={isProbing}
                      disabled={!key}
                      title="发送一次真实请求测试连通性"
                      className="h-7 px-2"
                    >
                      {isProbing ? null : <Zap className="h-3.5 w-3.5" />}
                      探测
                    </Button>
                    <Button
                      variant="secondary"
                      size="icon-sm"
                      onClick={() => onRemoveBinding(binding)}
                      title="移除绑定"
                      aria-label="移除绑定"
                      className="h-7 w-7 text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
