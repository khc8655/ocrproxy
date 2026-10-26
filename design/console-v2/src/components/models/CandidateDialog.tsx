import { useMemo, useState } from 'react'
import { Layers, Radar } from 'lucide-react'
import type { KbCandidate, ModelCategory, Provider } from '@/types'
import { Button, Field, Input, Select } from '@/components/ui/primitives'
import { Dialog } from '@/components/ui/dialog'
import { HealthBadge, SourceBadge } from '@/components/common/badges'
import { categoryLabels } from '@/components/common/semantics'
import { ProbeModelsDialog } from '@/components/models/ProbeModelsDialog'

export function CandidateDialog({
  open,
  category,
  editing,
  providers,
  onOpenChange,
  onAdd,
  onUpdate,
}: {
  open: boolean
  category: ModelCategory
  editing: KbCandidate | null
  providers: Provider[]
  onOpenChange: (next: boolean) => void
  onAdd: (candidates: KbCandidate[]) => void
  onUpdate: (candidate: KbCandidate) => void
}) {
  if (!open) return null
  return (
    <CandidateDialogForm
      key={`${category}:${editing?.id ?? 'new'}`}
      category={category}
      editing={editing}
      providers={providers}
      onOpenChange={onOpenChange}
      onAdd={onAdd}
      onUpdate={onUpdate}
    />
  )
}

function CandidateDialogForm({
  category,
  editing,
  providers,
  onOpenChange,
  onAdd,
  onUpdate,
}: {
  category: ModelCategory
  editing: KbCandidate | null
  providers: Provider[]
  onOpenChange: (next: boolean) => void
  onAdd: (candidates: KbCandidate[]) => void
  onUpdate: (candidate: KbCandidate) => void
}) {
  const providersWithKeys = useMemo(
    () => providers.filter((provider) => provider.keys.length > 0),
    [providers],
  )
  const [providerId, setProviderId] = useState(
    editing?.providerId ?? providersWithKeys[0]?.id ?? '',
  )
  const [selectedKeys, setSelectedKeys] = useState<string[]>(
    editing ? [editing.keyLabel] : [],
  )
  const [upstreamModel, setUpstreamModel] = useState(editing?.upstreamModel ?? '')
  const [probeOpen, setProbeOpen] = useState(false)

  const provider = providersWithKeys.find((item) => item.id === providerId) ?? null

  function toggleKey(label: string) {
    if (editing) {
      setSelectedKeys([label])
      return
    }
    setSelectedKeys((current) =>
      current.includes(label)
        ? current.filter((item) => item !== label)
        : [...current, label],
    )
  }

  const canSave =
    Boolean(provider) && selectedKeys.length > 0 && upstreamModel.trim().length > 0

  function handleSave() {
    if (!provider || !canSave) return
    if (editing) {
      onUpdate({
        ...editing,
        providerId: provider.id,
        keyLabel: selectedKeys[0],
        upstreamModel: upstreamModel.trim(),
      })
      onOpenChange(false)
      return
    }

    const stamp = Date.now()
    onAdd(
      selectedKeys.map((keyLabel, index) => ({
        id: `kb-${category}-${provider.id}-${keyLabel}-${stamp}-${index}`,
        category,
        providerId: provider.id,
        keyLabel,
        upstreamModel: upstreamModel.trim(),
      })),
    )
    onOpenChange(false)
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={onOpenChange}
        title={
          editing
            ? `编辑 ${categoryLabels[category]} 节点`
            : `挂载 ${categoryLabels[category]} 节点`
        }
        description={`挂载到 model="${category}" 的候选节点，按序号依次故障切换。`}
        icon={<Layers className="h-4 w-4" />}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={!canSave}>
              {editing ? '保存修改' : `挂载${selectedKeys.length > 1 ? `（${selectedKeys.length}）` : ''}`}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="上游供应商" htmlFor="candidate-provider">
            <Select
              id="candidate-provider"
              value={providerId}
              onChange={(event) => {
                setProviderId(event.target.value)
                if (!editing) setSelectedKeys([])
              }}
            >
              {providersWithKeys.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}（{item.keys.length} 个 Key）
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Key 与来源"
            hint={
              editing
                ? '编辑节点时只保留一个 Key；需要多 Key 挂载请新增节点'
                : `可勾选多个 Key，会按勾选顺序生成 ${categoryLabels[category]} 候选`
            }
          >
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="max-h-40 overflow-y-auto p-2">
                {provider ? (
                  provider.keys.map((key) => {
                    const checked = selectedKeys.includes(key.label)
                    return (
                      <label
                        key={key.label}
                        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-secondary"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleKey(key.label)}
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
          </Field>

          <Field
            label="上游实际模型 ID"
            htmlFor="candidate-model"
            hint="填写供应商侧真实模型名，例如 BAAI/bge-m3"
            aside={
              <button
                type="button"
                onClick={() => setProbeOpen(true)}
                disabled={!provider}
                className="inline-flex items-center gap-1 text-[10px] font-medium text-primary transition-colors hover:text-primary/80 disabled:cursor-not-allowed disabled:text-muted-foreground"
              >
                <Radar className="h-3 w-3" />
                探测模型
              </button>
            }
          >
            <Input
              id="candidate-model"
              value={upstreamModel}
              onChange={(event) => setUpstreamModel(event.target.value)}
              placeholder="例如 BAAI/bge-m3"
              className="font-mono text-xs"
            />
          </Field>
        </div>
      </Dialog>

      <ProbeModelsDialog
        open={probeOpen}
        provider={provider}
        onOpenChange={setProbeOpen}
        onPick={(model) => setUpstreamModel(model)}
      />
    </>
  )
}
