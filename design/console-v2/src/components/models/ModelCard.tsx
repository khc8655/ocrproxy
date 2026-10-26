import { Pencil, Trash2 } from 'lucide-react'
import type { AgentModel, Binding, Provider } from '@/types'
import { Badge, Button, Card } from '@/components/ui/primitives'
import { ProtocolBadges } from '@/components/common/badges'
import { BindingTable } from '@/components/models/BindingTable'

export function ModelCard({
  model,
  providers,
  probing,
  onEdit,
  onDelete,
  onProbe,
  onSetActive,
  onRemoveBinding,
  onReorderBindings,
}: {
  model: AgentModel
  providers: Provider[]
  probing: Set<string>
  onEdit: () => void
  onDelete: () => void
  onProbe: (binding: Binding) => void
  onSetActive: (binding: Binding) => void
  onRemoveBinding: (binding: Binding) => void
  onReorderBindings: (from: number, to: number) => void
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-lg font-semibold leading-none tracking-tight text-foreground">
              {model.id}
            </h3>
            <Badge tone="primary" className="text-[10px]">
              Agent
            </Badge>
            <ProtocolBadges protocols={model.protocols} />
            {model.upstreamModel && model.upstreamModel !== model.id ? (
              <Badge tone="neutral" className="font-mono text-[10px]">
                上游 {model.upstreamModel}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium text-secondary-foreground">
              {model.bindings.length} 个 Key
            </span>
            <span className="mx-1.5 text-border">·</span>
            按序故障转移
            {model.bindings.length > 1 ? (
              <>
                <span className="mx-1.5 text-border">·</span>
                输入序号排序
              </>
            ) : null}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            编辑
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onDelete}
            className="text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </Button>
        </div>
      </div>

      <div className="border-t border-border">
        <BindingTable
          model={model}
          providers={providers}
          probing={probing}
          onProbe={onProbe}
          onSetActive={onSetActive}
          onRemoveBinding={onRemoveBinding}
          onReorder={onReorderBindings}
        />
      </div>
    </Card>
  )
}
