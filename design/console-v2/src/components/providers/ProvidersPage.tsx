import { useMemo, useState } from 'react'
import { Plus, RefreshCw, Server } from 'lucide-react'
import type { HostKind, Provider, ProviderKey } from '@/types'
import {
  Button,
  EmptyState,
  PageHeader,
  SearchInput,
  Select,
} from '@/components/ui/primitives'
import { ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast-context'
import { ProviderRow } from '@/components/providers/ProviderCard'
import { ProviderDialog } from '@/components/providers/ProviderDialog'
import { KeyDialog } from '@/components/providers/KeyDialog'
import { vaultProviderCatalog } from '@/data/mock'
import { HOST_CAPABILITIES } from '@/lib/host'

type KeyDeleteTarget = {
  providerId: string
  providerName: string
  keyLabel: string
}

type KeyDialogTarget = {
  providerId: string
  editingKey: ProviderKey | null
}

type ProviderSort = 'name-asc' | 'name-desc' | 'keys-desc'

const providerNameCollator = new Intl.Collator('zh-CN', { sensitivity: 'base' })

export function ProvidersPage({
  providers,
  hostKind,
  onAddProvider,
  onUpdateProvider,
  onDeleteProvider,
  onAddKey,
  onUpdateKey,
  onDeleteKey,
  onApplyRuleUpdate,
}: {
  providers: Provider[]
  hostKind: HostKind
  onAddProvider: (provider: Provider) => void
  onUpdateProvider: (provider: Provider) => void
  onDeleteProvider: (providerId: string) => void
  onAddKey: (providerId: string, key: ProviderKey) => void
  onUpdateKey: (providerId: string, originalLabel: string, key: ProviderKey) => void
  onDeleteKey: (providerId: string, keyLabel: string) => void
  onApplyRuleUpdate: (providerId: string) => void
}) {
  const { toast } = useToast()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null)
  const [keyDeleteTarget, setKeyDeleteTarget] = useState<KeyDeleteTarget | null>(null)
  const [keyDialogTarget, setKeyDialogTarget] = useState<KeyDialogTarget | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ProviderSort>('name-asc')
  const keyDialogProvider = keyDialogTarget
    ? providers.find((provider) => provider.id === keyDialogTarget.providerId) ?? null
    : null

  const unconfiguredVaultProviders = vaultProviderCatalog.filter(
    (candidate) => !providers.some((provider) => provider.id === candidate.id),
  )

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const matched = keyword
      ? providers.filter((provider) => {
          const name = provider.name.toLowerCase()
          const id = provider.id.toLowerCase()
          return name.includes(keyword) || id.includes(keyword)
        })
      : providers

    function relevance(provider: Provider) {
      if (!keyword) return 0
      const name = provider.name.toLowerCase()
      const id = provider.id.toLowerCase()
      if (name === keyword || id === keyword) return 0
      if (name.startsWith(keyword) || id.startsWith(keyword)) return 1
      return 2
    }

    return [...matched].sort((a, b) => {
      const rank = relevance(a) - relevance(b)
      if (rank !== 0) return rank
      if (sort === 'keys-desc') {
        return (
          b.keys.length - a.keys.length || providerNameCollator.compare(a.name, b.name)
        )
      }
      const order = providerNameCollator.compare(a.name, b.name)
      return sort === 'name-desc' ? -order : order
    })
  }, [providers, query, sort])

  function handleSave(provider: Provider) {
    const duplicated =
      !editing &&
      providers.some((item) => item.id.toLowerCase() === provider.id.toLowerCase())
    if (duplicated) {
      toast({
        title: '供应商已存在',
        description: `「${provider.name}」已在列表中，请修改名称后再创建。`,
        variant: 'error',
      })
      return
    }

    if (editing) {
      onUpdateProvider(provider)
      toast({ title: '供应商已更新', description: `${provider.name} 的配置已立即生效` })
    } else {
      onAddProvider(provider)
      setQuery('')
      if (provider.origin === 'vault') {
        toast({
          title: '已从中枢拉取供应商',
          description: `${provider.name} 与 ${provider.keys.length} 个只读 Key 已加入本地`,
        })
      } else {
        setKeyDialogTarget({ providerId: provider.id, editingKey: null })
        toast({
          title: '供应商已创建',
          description: '接着填入 Key，添加后即可用于模型路由',
        })
      }
    }
    setDialogOpen(false)
    setEditing(null)
  }

  const pendingRules = providers.filter((provider) => provider.ruleUpdate).length

  function handleCheckRules() {
    if (!pendingRules) {
      toast({
        title: '适配规则已是最新',
        description: '当前没有需要升级的供应商规则',
        variant: 'info',
      })
      return
    }
    providers
      .filter((provider) => provider.ruleUpdate)
      .forEach((provider) => onApplyRuleUpdate(provider.id))
    toast({
      title: '适配规则已更新',
      description: `${pendingRules} 家供应商的规则已升级并立即生效`,
    })
  }

  return (
    <div>
      <PageHeader
        title="供应商"
        description="按供应商管理上游 Key；中枢同步的 Key 为只读，本地 Key 可添加或删除。"
        actions={
          <>
            <Button variant="secondary" onClick={handleCheckRules}>
              <RefreshCw className="h-3.5 w-3.5" />
              {pendingRules ? `更新适配规则（${pendingRules}）` : '检查适配规则'}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              新增供应商
            </Button>
          </>
        }
      />

      {providers.length ? (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="flex flex-col gap-2 border-b border-border bg-secondary/20 px-4 py-2.5 sm:flex-row sm:items-center">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="搜索供应商名称"
              className="sm:w-64"
            />
            <div className="flex items-center gap-2 sm:ml-auto">
              <span className="text-[11px] text-muted-foreground">
                {query.trim()
                  ? `${visible.length} / ${providers.length} 家`
                  : `${providers.length} 家`}
              </span>
              <Select
                value={sort}
                onChange={(event) => setSort(event.target.value as ProviderSort)}
                aria-label="供应商排序"
                className="h-9 w-[150px] text-xs"
              >
                <option value="name-asc">名称 A–Z</option>
                <option value="name-desc">名称 Z–A</option>
                <option value="keys-desc">Key 数量多到少</option>
              </Select>
            </div>
          </div>
          {visible.length ? (
            <div className="divide-y divide-border">
              {visible.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  hostKind={hostKind}
                  onEdit={() => {
                    setEditing(provider)
                    setDialogOpen(true)
                  }}
                  onDelete={() => setDeleteTarget(provider)}
                  onAddKey={() =>
                    setKeyDialogTarget({ providerId: provider.id, editingKey: null })
                  }
                  onEditKey={(keyLabel) => {
                    const key = provider.keys.find((item) => item.label === keyLabel)
                    if (!key) return
                    setKeyDialogTarget({ providerId: provider.id, editingKey: key })
                  }}
                  onDeleteKey={(keyLabel) =>
                    setKeyDeleteTarget({
                      providerId: provider.id,
                      providerName: provider.name,
                      keyLabel,
                    })
                  }
                  onApplyRuleUpdate={() => {
                    onApplyRuleUpdate(provider.id)
                    toast({
                      title: '适配规则已更新',
                      description: `${provider.name} 已升级至 ${provider.ruleUpdate?.remoteVersion ?? '最新版本'}`,
                    })
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
              <p className="text-xs text-muted-foreground">
                没有找到匹配「{query.trim()}」的供应商。
              </p>
              <Button variant="secondary" size="sm" onClick={() => setQuery('')}>
                清除搜索
              </Button>
            </div>
          )}
        </div>
      ) : (
        <EmptyState
          icon={<Server className="h-5 w-5" />}
          title="还没有供应商"
          description="添加上游供应商与 API Key 后，即可在模型中绑定并使用。"
          action={
            <Button variant="primary" onClick={() => setDialogOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              新增供应商
            </Button>
          }
        />
      )}

      <ProviderDialog
        open={dialogOpen}
        onOpenChange={(next) => {
          setDialogOpen(next)
          if (!next) setEditing(null)
        }}
        editing={editing}
        readOnly={
          HOST_CAPABILITIES[hostKind].vaultClient && editing?.origin === 'vault'
        }
        hostKind={hostKind}
        vaultCandidates={
          HOST_CAPABILITIES[hostKind].vaultClient ? unconfiguredVaultProviders : []
        }
        onSave={handleSave}
      />

      <KeyDialog
        open={keyDialogTarget !== null}
        provider={keyDialogProvider}
        editingKey={keyDialogTarget?.editingKey ?? null}
        hostKind={hostKind}
        onOpenChange={(next) => {
          if (!next) setKeyDialogTarget(null)
        }}
        onSave={(originalLabel, key) => {
          if (!keyDialogTarget) return
          if (originalLabel) {
            onUpdateKey(keyDialogTarget.providerId, originalLabel, key)
            toast({
              title: 'Key 已更新',
              description: `${key.label} 的凭证与状态已保存`,
            })
          } else {
            onAddKey(keyDialogTarget.providerId, key)
            toast({
              title: 'Key 已添加',
              description: `${key.label} 已加入 ${keyDialogProvider?.name ?? '供应商'}`,
            })
          }
        }}
      />

      <ConfirmDialog
        open={keyDeleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setKeyDeleteTarget(null)
        }}
        title="删除这个 Key？"
        description={`Key「${keyDeleteTarget?.keyLabel ?? ''}」将从 ${keyDeleteTarget?.providerName ?? ''} 中移除，引用它的模型绑定也会同步清理。`}
        confirmLabel="确认删除"
        onConfirm={() => {
          if (!keyDeleteTarget) return
          onDeleteKey(keyDeleteTarget.providerId, keyDeleteTarget.keyLabel)
          toast({
            title: 'Key 已删除',
            description: `${keyDeleteTarget.keyLabel} 及其关联绑定已清理`,
            variant: 'info',
          })
          setKeyDeleteTarget(null)
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null)
        }}
        title={`删除供应商「${deleteTarget?.name ?? ''}」？`}
        description="该供应商下的所有 Key 都会移除，引用这些 Key 的模型绑定也会同步清理，此操作不可撤销。"
        confirmLabel="确认删除"
        onConfirm={() => {
          if (!deleteTarget) return
          onDeleteProvider(deleteTarget.id)
          toast({
            title: '供应商已删除',
            description: '关联的 Key 与模型绑定已同步清理',
            variant: 'info',
          })
          setDeleteTarget(null)
        }}
      />
    </div>
  )
}
