import { useState } from 'react'
import { CloudDownload, Lock, Server } from 'lucide-react'
import type { HostKind, Protocol, Provider } from '@/types'
import { Button, Field, Input, Select } from '@/components/ui/primitives'
import { Dialog } from '@/components/ui/dialog'
import {
  protocolOptions,
  protocolSelectedClass,
  providerOriginText,
} from '@/components/common/semantics'
import { DEFAULT_ADAPTER_VERSION } from '@/lib/constants'
import { HOST_CAPABILITIES } from '@/lib/host'
import { cn } from '@/lib/utils'

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function ProviderDialog({
  open,
  onOpenChange,
  editing,
  readOnly = false,
  hostKind,
  vaultCandidates,
  onSave,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  editing: Provider | null
  readOnly?: boolean
  hostKind: HostKind
  vaultCandidates: Provider[]
  onSave: (provider: Provider) => void
}) {
  if (!open) return null
  return (
    <ProviderDialogForm
      key={editing?.id ?? 'new'}
      editing={editing}
      readOnly={readOnly}
      hostKind={hostKind}
      vaultCandidates={vaultCandidates}
      onOpenChange={onOpenChange}
      onSave={onSave}
    />
  )
}

function ProviderDialogForm({
  editing,
  readOnly,
  hostKind,
  vaultCandidates,
  onOpenChange,
  onSave,
}: {
  editing: Provider | null
  readOnly: boolean
  hostKind: HostKind
  vaultCandidates: Provider[]
  onOpenChange: (next: boolean) => void
  onSave: (provider: Provider) => void
}) {
  const [source, setSource] = useState<'local' | 'vault'>('local')
  const [vaultId, setVaultId] = useState('')
  const [name, setName] = useState(editing?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '')
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState(editing?.anthropicBaseUrl ?? '')
  const [rpm, setRpm] = useState(String(editing?.rpm ?? 300))
  const [protocols, setProtocols] = useState<Protocol[]>(editing?.protocols ?? ['chat'])

  const vaultChoice =
    vaultCandidates.find((candidate) => candidate.id === vaultId) ?? null
  const isVaultPull = !editing && source === 'vault' && vaultChoice !== null
  const locked = readOnly || isVaultPull
  const effectiveName = vaultChoice?.name ?? name
  const effectiveBaseUrl = vaultChoice?.baseUrl ?? baseUrl
  const effectiveAnthropicUrl =
    vaultChoice?.anthropicBaseUrl ?? anthropicBaseUrl
  const effectiveRpm = vaultChoice ? vaultChoice.rpm : Number(rpm) || 0
  const effectiveProtocols = vaultChoice?.protocols ?? protocols

  function toggleProtocol(protocol: Protocol) {
    if (locked) return
    setProtocols((current) =>
      current.includes(protocol)
        ? current.filter((item) => item !== protocol)
        : [...current, protocol],
    )
  }

  const canSave =
    !readOnly &&
    effectiveName.trim().length > 0 &&
    effectiveBaseUrl.trim().length > 0 &&
    effectiveProtocols.length > 0 &&
    (!isVaultPull || vaultChoice !== null)

  function handleSave() {
    if (!canSave) return
    const provider: Provider = {
      id:
        vaultChoice?.id ??
        editing?.id ??
        (slugify(name) || `provider-${Date.now()}`),
      name: effectiveName.trim(),
      baseUrl: effectiveBaseUrl.trim(),
      anthropicBaseUrl: effectiveAnthropicUrl.trim() || undefined,
      rpm: effectiveRpm,
      origin: editing?.origin ?? (vaultChoice || hostKind === 'edgeone' ? 'vault' : 'local'),
      adapterVersion: editing?.adapterVersion ?? DEFAULT_ADAPTER_VERSION,
      protocols: effectiveProtocols,
      description:
        editing?.description ??
        (vaultChoice
          ? '从中枢拉取的托管供应商，Key 只读可删'
          : '自定义接入的上游供应商'),
      keys: vaultChoice
        ? vaultChoice.keys.map((key) => ({
            ...key,
            source: 'vault',
            health: 'idle',
            latencyMs: null,
            lastUsed: '尚未调用',
          }))
        : editing?.keys ?? [],
      ruleUpdate: editing?.ruleUpdate ?? null,
    }
    onSave(provider)
  }

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={editing ? `编辑供应商 · ${editing.name}` : '新增供应商'}
      description={
        readOnly
          ? '中枢托管供应商的端点与协议由中枢统一维护，在 VM 本地只读。'
          : isVaultPull
            ? '从 EdgeOne 凭据中枢按需拉取供应商规则与全部 Key，Key 只读可删。'
            : '配置上游地址、协议能力与速率限制，凭证可单独添加。'
      }
      icon={<Server className="h-4 w-4" />}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {readOnly ? '关闭' : '取消'}
          </Button>
          {!readOnly ? (
            <Button variant="primary" onClick={handleSave} disabled={!canSave}>
              {editing
                ? '保存修改'
                : isVaultPull
                  ? `拉取「${vaultChoice?.name ?? ''}」`
                  : '创建供应商'}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {readOnly ? (
          <div className="flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5 text-[11px] leading-5 text-primary sm:col-span-2">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              该供应商来自 EdgeOne 凭据中枢。在 VM 端请使用「增量同步中枢规则」更新规则与端点；如需修改，请到 EdgeOne 中枢控制台操作。
            </span>
          </div>
        ) : null}

        {!editing &&
        HOST_CAPABILITIES[hostKind].vaultClient &&
        vaultCandidates.length ? (
          <Field
            label="供应商来源"
            htmlFor="provider-source"
            hint={
              source === 'vault'
                ? '中枢已有的供应商可直接拉取，无需重复填写端点与协议'
                : '自定义供应商适用于私有部署或任意兼容端点'
            }
            className="sm:col-span-2"
          >
            <Select
              id="provider-source"
              value={source === 'vault' ? `vault:${vaultId}` : 'local'}
              onChange={(event) => {
                const value = event.target.value
                if (value.startsWith('vault:')) {
                  setSource('vault')
                  setVaultId(value.slice(6))
                } else {
                  setSource('local')
                  setVaultId('')
                }
              }}
            >
              <option value="local">自定义供应商（手动填写）</option>
              <optgroup label="EdgeOne 凭据中枢托管（按需拉取）">
                {vaultCandidates.map((candidate) => (
                  <option key={candidate.id} value={`vault:${candidate.id}`}>
                    {candidate.name}（{candidate.keys.length} 个 Key）
                  </option>
                ))}
              </optgroup>
            </Select>
          </Field>
        ) : null}

        {isVaultPull ? (
          <div className="flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5 text-[11px] leading-5 text-primary sm:col-span-2">
            <CloudDownload className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              「{vaultChoice?.name}」已在中枢托管，保存后会拉取供应商规则与{' '}
              {vaultChoice?.keys.length ?? 0} 个 Key。中枢 Key 只读可删，自建 Key 为本地。
            </span>
          </div>
        ) : null}

        <Field label="供应商名称" htmlFor="provider-name">
          <Input
            id="provider-name"
            value={effectiveName}
            readOnly={locked}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 DeepSeek"
          />
        </Field>

        <Field label="每 Key 每分钟请求上限" hint="0 表示不限制" htmlFor="provider-rpm">
          <Input
            id="provider-rpm"
            type="number"
            min={0}
            value={isVaultPull ? String(effectiveRpm) : rpm}
            readOnly={locked}
            onChange={(event) => setRpm(event.target.value)}
            className="tnum"
          />
        </Field>

        <Field
          label="OpenAI Base URL"
          hint="Chat 与 Responses 协议共用"
          htmlFor="provider-url"
          className="sm:col-span-2"
        >
          <Input
            id="provider-url"
            value={effectiveBaseUrl}
            readOnly={locked}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
            className="font-mono text-xs"
          />
        </Field>

        <Field
          label="Anthropic Messages Base URL"
          hint="留空时沿用上面的 Base URL"
          htmlFor="provider-anthropic-url"
          className="sm:col-span-2"
        >
          <Input
            id="provider-anthropic-url"
            value={effectiveAnthropicUrl}
            readOnly={locked}
            onChange={(event) => setAnthropicBaseUrl(event.target.value)}
            placeholder="https://api.example.com/anthropic"
            className="font-mono text-xs"
          />
        </Field>

        <Field
          label="支持的协议"
          hint="至少选择一种；同时支持多种协议的供应商会出现在对应路由中"
          className="sm:col-span-2"
        >
          <div className="flex flex-wrap gap-2" role="group" aria-label="支持的协议">
            {protocolOptions.map((protocol) => {
              const active = effectiveProtocols.includes(protocol.value)
              return (
                <button
                  key={protocol.value}
                  type="button"
                  disabled={locked}
                  onClick={() => toggleProtocol(protocol.value)}
                  className={cn(
                    'h-8 rounded-xl border px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
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

        {editing ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground sm:col-span-2">
            <span>
              适配规则{' '}
              <b className="font-mono text-secondary-foreground">
                {editing.adapterVersion || DEFAULT_ADAPTER_VERSION}
              </b>
            </span>
            <span>
              来源{' '}
              <b className="text-secondary-foreground">
                {providerOriginText(editing.origin, hostKind)}
              </b>
            </span>
            {editing.ruleUpdate ? (
              <span className="text-warning">
                可升级至 <b className="font-mono">{editing.ruleUpdate.remoteVersion}</b>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
