import { useMemo, useState } from 'react'
import { Globe2, KeyRound, Link2, Lock } from 'lucide-react'
import type { HostKind, Provider, ProviderKey } from '@/types'
import { Badge, Button, Field, Input } from '@/components/ui/primitives'
import { Dialog } from '@/components/ui/dialog'
import { ProtocolBadges, SourceBadge } from '@/components/common/badges'
import { vaultKeyCandidates } from '@/data/mock'
import { HOST_CAPABILITIES } from '@/lib/host'
import { cn, maskSecret } from '@/lib/utils'

function isVertexProvider(provider: Provider) {
  const haystack = `${provider.id} ${provider.name} ${provider.baseUrl}`.toLowerCase()
  return haystack.includes('vertex') || haystack.includes('aiplatform.googleapis.com')
}

function vertexEndpoint(projectId: string, location: string) {
  const project = projectId.trim() || '{project_id}'
  const region = (location.trim() || 'global').toLowerCase()
  const host =
    region === 'global'
      ? 'aiplatform.googleapis.com'
      : `${region}-aiplatform.googleapis.com`
  return `https://${host}/v1beta1/projects/${project}/locations/${region}/endpoints/openapi`
}

export function KeyDialog({
  open,
  provider,
  editingKey,
  hostKind,
  onOpenChange,
  onSave,
}: {
  open: boolean
  provider: Provider | null
  editingKey: ProviderKey | null
  hostKind: HostKind
  onOpenChange: (next: boolean) => void
  onSave: (originalLabel: string | null, key: ProviderKey) => void
}) {
  if (!open || !provider) return null
  return (
    <KeyDialogForm
      key={`${provider.id}:${editingKey?.label ?? 'new'}`}
      provider={provider}
      editingKey={editingKey}
      hostKind={hostKind}
      onOpenChange={onOpenChange}
      onSave={onSave}
    />
  )
}

function KeyDialogForm({
  provider,
  editingKey,
  hostKind,
  onOpenChange,
  onSave,
}: {
  provider: Provider
  editingKey: ProviderKey | null
  hostKind: HostKind
  onOpenChange: (next: boolean) => void
  onSave: (originalLabel: string | null, key: ProviderKey) => void
}) {
  const vertex = isVertexProvider(provider)
  const vaultReadOnly =
    HOST_CAPABILITIES[hostKind].vaultClient && editingKey?.source === 'vault'
  const [label, setLabel] = useState(editingKey?.label ?? '')
  const [secret, setSecret] = useState('')
  const [skipCheck, setSkipCheck] = useState(Boolean(editingKey))
  const [projectId, setProjectId] = useState(editingKey?.projectId ?? '')
  const [location, setLocation] = useState(editingKey?.location ?? 'global')
  const [vaultPicked, setVaultPicked] = useState<string[]>([])

  const availableVaultKeys = useMemo(() => {
    if (
      !HOST_CAPABILITIES[hostKind].vaultClient ||
      provider.origin !== 'vault' ||
      editingKey
    ) {
      return []
    }
    const local = new Set(provider.keys.map((key) => key.label))
    return (vaultKeyCandidates[provider.id] ?? []).filter((item) => !local.has(item))
  }, [editingKey, hostKind, provider])

  const duplicate =
    label.trim().length > 0 &&
    provider.keys.some(
      (key) => key.label === label.trim() && key.label !== editingKey?.label,
    )
  const canSave =
    !vaultReadOnly &&
    !duplicate &&
    (editingKey
      ? label.trim().length > 0 && (secret.trim().length > 0 || editingKey.masked.length > 0)
      : vaultPicked.length > 0 || (label.trim().length > 0 && secret.trim().length > 0))

  function handleSave() {
    if (!canSave) return

    if (editingKey) {
      onSave(editingKey.label, {
        ...editingKey,
        label: label.trim(),
        masked: secret.trim() ? maskSecret(secret) : editingKey.masked,
        health: secret.trim() ? 'ok' : editingKey.health,
        latencyMs: secret.trim() ? 640 : editingKey.latencyMs,
        lastUsed: secret.trim() ? '刚刚' : editingKey.lastUsed,
        projectId: vertex ? projectId.trim() || undefined : undefined,
        location: vertex ? location.trim() || 'global' : undefined,
      })
      onOpenChange(false)
      return
    }

    vaultPicked.forEach((vaultLabel) => {
      onSave(null, {
        label: vaultLabel,
        masked: '•••••••• 中枢只读',
        source: 'vault',
        health: 'idle',
        lastUsed: '尚未调用',
      })
    })

    if (label.trim() && secret.trim()) {
      onSave(null, {
        label: label.trim(),
        masked: maskSecret(secret),
        source:
          HOST_CAPABILITIES[hostKind].vaultHub && provider.origin === 'vault'
            ? 'vault'
            : 'local',
        health: 'ok',
        latencyMs: 680,
        lastUsed: '刚刚',
        projectId: vertex ? projectId.trim() || undefined : undefined,
        location: vertex ? location.trim() || 'global' : undefined,
      })
    }

    onOpenChange(false)
  }

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={editingKey ? `编辑 Key · ${editingKey.label}` : `为 ${provider.name} 添加 Key`}
      description={
        vaultReadOnly
          ? '该 Key 由 EdgeOne 中枢统一维护，在 VM 本地只读，可删除但不可修改。'
          : 'Key 会先按供应商支持的协议做连通性校验，通过后立即参与路由。'
      }
      icon={<KeyRound className="h-4 w-4" />}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {vaultReadOnly ? '关闭' : '取消'}
          </Button>
          {!vaultReadOnly ? (
            <Button variant="primary" onClick={handleSave} disabled={!canSave}>
              {editingKey ? '保存修改' : `添加${vaultPicked.length ? `（${vaultPicked.length + (label.trim() && secret.trim() ? 1 : 0)}）` : ''}`}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-secondary/40 px-3 py-2">
        <span className="text-[11px] text-secondary-foreground">
          供应商 <b className="text-foreground">{provider.name}</b>
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {editingKey ? <SourceBadge source={editingKey.source} /> : null}
          <ProtocolBadges protocols={provider.protocols} />
        </div>
      </div>

      {vaultReadOnly ? (
        <div className="flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5 text-[11px] leading-5 text-primary">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            中枢 Key 的值不会回显到本地。需要替换或修改时，请到 EdgeOne 中枢控制台维护，然后在 VM 执行「增量同步中枢规则」。
          </span>
        </div>
      ) : (
        <div className="space-y-4">
          {availableVaultKeys.length ? (
            <div className="rounded-xl border border-border bg-secondary/30 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-foreground">从中枢添加</p>
                <span className="text-[10px] text-muted-foreground">只新增，不覆盖</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {availableVaultKeys.map((item) => {
                  const active = vaultPicked.includes(item)
                  return (
                    <button
                      key={item}
                      type="button"
                      onClick={() =>
                        setVaultPicked((current) =>
                          current.includes(item)
                            ? current.filter((value) => value !== item)
                            : [...current, item],
                        )
                      }
                      className={cn(
                        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[11px] transition-colors',
                        active
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border bg-card text-secondary-foreground hover:border-primary/30',
                      )}
                    >
                      {active ? <Lock className="h-3 w-3" /> : null}
                      {item}
                    </button>
                  )
                })}
              </div>
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                勾选后与下方手动录入的本地 Key 一并保存；拉取的中枢 Key 只读可删。
              </p>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Key 标签别名" htmlFor="key-label" hint="用于模型绑定与日志定位">
              <Input
                id="key-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="例如 prod-01"
                className="font-mono text-xs"
              />
            </Field>
            <Field
              label="API Key 密钥值"
              htmlFor="key-secret"
              hint={editingKey?.masked ? '留空保留原值' : undefined}
            >
              <Input
                id="key-secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={editingKey?.masked || 'sk-...'}
                className="font-mono text-xs"
              />
            </Field>
          </div>

          {duplicate ? (
            <p className="text-[11px] text-destructive">该别名已存在，请换一个名称。</p>
          ) : null}

          {vertex ? (
            <div className="rounded-xl border border-border bg-secondary/30 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Globe2 className="h-3.5 w-3.5" />
                Google Cloud Vertex AI 专属参数
              </p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label="GCP 项目 ID" htmlFor="key-vertex-project" hint="凭证与项目强绑定">
                  <Input
                    id="key-vertex-project"
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                    placeholder="my-gcp-project-123456"
                    className="font-mono text-xs"
                  />
                </Field>
                <Field label="服务区域" htmlFor="key-vertex-location" hint="默认 global">
                  <Input
                    id="key-vertex-location"
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder="global"
                    className="font-mono text-xs"
                  />
                </Field>
              </div>
              <p className="mt-2 flex items-start gap-1 text-[10px] leading-4 text-muted-foreground">
                <Link2 className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="break-all font-mono">
                  {vertexEndpoint(projectId, location)}
                </span>
              </p>
            </div>
          ) : null}

          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-secondary-foreground">
            <input
              type="checkbox"
              checked={skipCheck}
              onChange={(event) => setSkipCheck(event.target.checked)}
              className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
            />
            跳过连通性在线校验，直接保存
          </label>

          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <Badge tone="neutral">保存时校验</Badge>
            <ProtocolBadges protocols={provider.protocols} />
            <span>连通性</span>
          </div>
        </div>
      )}
    </Dialog>
  )
}
