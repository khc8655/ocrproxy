import { useMemo, useState } from 'react'
import { Radar, Route, X } from 'lucide-react'
import type { AgentModel, Binding, Protocol, Provider } from '@/types'
import { Badge, Button, Field, Input, Select } from '@/components/ui/primitives'
import { Dialog } from '@/components/ui/dialog'
import { HealthBadge, SourceBadge } from '@/components/common/badges'
import {
  protocolOptions,
  protocolSelectedClass,
} from '@/components/common/semantics'
import { ProbeModelsDialog } from '@/components/models/ProbeModelsDialog'
import { cn } from '@/lib/utils'

export function ModelDialog({
  open,
  onOpenChange,
  editing,
  providers,
  onSave,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  editing: AgentModel | null
  providers: Provider[]
  onSave: (model: AgentModel, isEdit: boolean) => boolean
}) {
  if (!open) return null
  return (
    <ModelDialogForm
      key={editing?.id ?? 'new'}
      editing={editing}
      providers={providers}
      onOpenChange={onOpenChange}
      onSave={onSave}
    />
  )
}

function ModelDialogForm({
  editing,
  providers,
  onOpenChange,
  onSave,
}: {
  editing: AgentModel | null
  providers: Provider[]
  onOpenChange: (next: boolean) => void
  onSave: (model: AgentModel, isEdit: boolean) => boolean
}) {
  const providersWithKeys = useMemo(
    () => providers.filter((provider) => provider.keys.length > 0),
    [providers],
  )

  const [id, setId] = useState(editing?.id ?? '')
  const [upstream, setUpstream] = useState(editing?.upstreamModel ?? '')
  const [protocols, setProtocols] = useState<Protocol[]>(editing?.protocols ?? ['chat'])
  const [bindings, setBindings] = useState<Binding[]>(editing?.bindings ?? [])
  const [providerId, setProviderId] = useState(
    editing?.bindings[0]?.providerId ?? providersWithKeys[0]?.id ?? '',
  )
  const [probeOpen, setProbeOpen] = useState(false)

  const activeProvider = providersWithKeys.find((provider) => provider.id === providerId)

  function isBound(providerKeyId: string, keyLabel: string) {
    return bindings.some(
      (binding) => binding.providerId === providerKeyId && binding.keyLabel === keyLabel,
    )
  }

  function toggleBinding(providerKeyId: string, keyLabel: string) {
    setBindings((current) => {
      const exists = current.some(
        (binding) => binding.providerId === providerKeyId && binding.keyLabel === keyLabel,
      )
      if (exists) {
        return current.filter(
          (binding) =>
            !(binding.providerId === providerKeyId && binding.keyLabel === keyLabel),
        )
      }
      return [...current, { providerId: providerKeyId, keyLabel }]
    })
  }

  function toggleProtocol(protocol: Protocol) {
    setProtocols((current) =>
      current.includes(protocol)
        ? current.filter((item) => item !== protocol)
        : [...current, protocol],
    )
  }

  const canSave = id.trim().length > 0 && bindings.length > 0

  function handleSave() {
    if (!canSave) return
    const stillValid =
      editing &&
      bindings.some(
        (binding) => `${binding.providerId}:${binding.keyLabel}` === editing.activeKey,
      )
    const first = bindings[0]
    const model: AgentModel = {
      id: id.trim(),
      upstreamModel: upstream.trim() || undefined,
      protocols: protocols.length ? protocols : ['chat'],
      category: 'chat',
      activeKey: stillValid
        ? editing.activeKey
        : first
          ? `${first.providerId}:${first.keyLabel}`
          : '',
      bindings,
    }
    const ok = onSave(model, Boolean(editing))
    if (ok) onOpenChange(false)
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={onOpenChange}
        title={editing ? `编辑模型 · ${editing.id}` : '新增 Agent 模型'}
        description="对外暴露一个模型名，并为它绑定多个供应商的 Key 作为故障转移候选。"
        icon={<Route className="h-4 w-4" />}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={!canSave}>
              {editing ? '保存修改' : '创建模型'}
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="模型 ID" htmlFor="model-id" hint="客户端调用时填写的 model 名称">
            <Input
              id="model-id"
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="例如 claude-sonnet-5"
              disabled={Boolean(editing)}
              className="font-mono text-xs"
            />
          </Field>

          <Field
            label="上游模型 ID"
            htmlFor="model-upstream"
            hint="留空则与模型 ID 相同"
            aside={
              <button
                type="button"
                onClick={() => setProbeOpen(true)}
                disabled={!activeProvider}
                className="inline-flex items-center gap-1 text-[10px] font-medium text-primary transition-colors hover:text-primary/80 disabled:cursor-not-allowed disabled:text-muted-foreground"
              >
                <Radar className="h-3 w-3" />
                探测上游模型
              </button>
            }
          >
            <Input
              id="model-upstream"
              value={upstream}
              onChange={(event) => setUpstream(event.target.value)}
              placeholder="例如 claude-sonnet-4-5-20250929"
              className="font-mono text-xs"
            />
          </Field>

          <Field
            label="对外协议"
            hint="同时勾选多个协议时，同一个模型可使用不同协议访问"
            className="sm:col-span-2"
          >
            <div className="flex flex-wrap gap-2" role="group" aria-label="对外协议">
              {protocolOptions.map((protocol) => {
                const active = protocols.includes(protocol.value)
                return (
                  <button
                    key={protocol.value}
                    type="button"
                    onClick={() => toggleProtocol(protocol.value)}
                    className={cn(
                      'h-8 rounded-xl border px-3 text-xs font-medium transition-colors',
                      active
                        ? protocolSelectedClass(protocol.value)
                        : 'border-border bg-card text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {protocol.label}
                  </button>
                )
              })}
            </div>
          </Field>

          <Field
            label="绑定 Key"
            hint="勾选多个供应商的 Key，请求会按顺序故障转移"
            className="sm:col-span-2"
          >
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="flex flex-wrap items-center gap-2 border-b border-border bg-secondary/50 px-3 py-2.5">
                <Select
                  value={providerId}
                  onChange={(event) => setProviderId(event.target.value)}
                  aria-label="选择供应商"
                  className="h-8 w-full bg-card text-xs sm:w-56"
                >
                  {providersWithKeys.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}（{provider.keys.length} 个 Key）
                    </option>
                  ))}
                </Select>
                {activeProvider ? (
                  <span className="text-[11px] text-muted-foreground">
                    已选 {bindings.length} 个 Key
                  </span>
                ) : null}
              </div>

              <div className="max-h-44 overflow-y-auto p-2">
                {activeProvider ? (
                  activeProvider.keys.map((key) => {
                    const checked = isBound(activeProvider.id, key.label)
                    return (
                      <label
                        key={key.label}
                        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-secondary"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleBinding(activeProvider.id, key.label)}
                          className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                        />
                        <span className="font-mono text-[11px] font-medium text-foreground">
                          {key.label}
                        </span>
                        <SourceBadge source={key.source} />
                        <span className="ml-auto">
                          <HealthBadge health={key.health} latencyMs={key.latencyMs} />
                        </span>
                      </label>
                    )
                  })
                ) : (
                  <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                    暂无可用 Key，请先在供应商中添加凭证。
                  </p>
                )}
              </div>
            </div>

            {bindings.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {bindings.map((binding) => (
                  <span
                    key={`${binding.providerId}:${binding.keyLabel}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground"
                  >
                    <span className="font-mono">
                      {binding.providerId}/{binding.keyLabel}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleBinding(binding.providerId, binding.keyLabel)}
                      className="rounded-full p-0.5 text-muted-foreground hover:text-destructive"
                      aria-label="移除绑定"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className="mt-2">
                <Badge tone="warning">至少绑定一个 Key 才能保存</Badge>
              </div>
            )}
          </Field>
        </div>
      </Dialog>

      <ProbeModelsDialog
        open={probeOpen}
        provider={activeProvider ?? null}
        onOpenChange={setProbeOpen}
        onPick={(model) => setUpstream(model)}
      />
    </>
  )
}
