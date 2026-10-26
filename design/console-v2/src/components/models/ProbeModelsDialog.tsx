import { useState } from 'react'
import { Radar, Search } from 'lucide-react'
import type { Provider } from '@/types'
import { Badge, Button, Input } from '@/components/ui/primitives'
import { Dialog } from '@/components/ui/dialog'
import { probeModelCatalog } from '@/data/mock'

export function ProbeModelsDialog({
  open,
  provider,
  onOpenChange,
  onPick,
}: {
  open: boolean
  provider: Provider | null
  onOpenChange: (next: boolean) => void
  onPick: (model: string) => void
}) {
  if (!open || !provider) return null
  return (
    <ProbeModelsList
      key={provider.id}
      provider={provider}
      onOpenChange={onOpenChange}
      onPick={onPick}
    />
  )
}

function ProbeModelsList({
  provider,
  onOpenChange,
  onPick,
}: {
  provider: Provider
  onOpenChange: (next: boolean) => void
  onPick: (model: string) => void
}) {
  const catalog = probeModelCatalog[provider.id] ?? []
  const [keyword, setKeyword] = useState('')
  const visible = catalog.filter((model) =>
    model.toLowerCase().includes(keyword.trim().toLowerCase()),
  )

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`探测上游模型 · ${provider.name}`}
      description="按该供应商的适配规则探测可用模型，选中后回填上游模型 ID。"
      icon={<Radar className="h-4 w-4" />}
      size="md"
      footer={
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          关闭
        </Button>
      }
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="筛选模型名"
          className="pl-9"
        />
      </div>

      <div className="mt-3 max-h-72 space-y-1.5 overflow-y-auto">
        {visible.length ? (
          visible.map((model) => (
            <button
              key={model}
              type="button"
              onClick={() => {
                onPick(model)
                onOpenChange(false)
              }}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-secondary/40"
            >
              <span className="truncate font-mono text-xs font-medium text-foreground">
                {model}
              </span>
              <Badge tone="success">可调用</Badge>
            </button>
          ))
        ) : (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            没有匹配的模型。可直接手动填写上游模型 ID。
          </p>
        )}
      </div>

      <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
        探测结果来自该供应商适配规则中的模型清单，实际可用性以保存时连通性校验为准。
      </p>
    </Dialog>
  )
}
