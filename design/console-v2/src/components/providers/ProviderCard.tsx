import { ArrowUpCircle, Globe2, Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import type { HostKind, Provider } from '@/types'
import { Badge, Button } from '@/components/ui/primitives'
import { ProtocolBadges } from '@/components/common/badges'
import {
  providerOriginText,
  providerOriginTone,
  sourceLabel,
  sourceTextClass,
} from '@/components/common/semantics'
import { DEFAULT_ADAPTER_VERSION } from '@/lib/constants'
import { HOST_CAPABILITIES } from '@/lib/host'
import { cn } from '@/lib/utils'

export function ProviderRow({
  provider,
  hostKind,
  onEdit,
  onDelete,
  onAddKey,
  onEditKey,
  onDeleteKey,
  onApplyRuleUpdate,
}: {
  provider: Provider
  hostKind: HostKind
  onEdit: () => void
  onDelete: () => void
  onAddKey: () => void
  onEditKey: (keyLabel: string) => void
  onDeleteKey: (keyLabel: string) => void
  onApplyRuleUpdate: () => void
}) {
  const vaultClient = HOST_CAPABILITIES[hostKind].vaultClient
  const readOnlyVault = vaultClient && provider.origin === 'vault'

  return (
    <div className="px-5 py-4 transition-colors hover:bg-secondary/20">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              {provider.name}
            </h3>
            <Badge tone={providerOriginTone[provider.origin]} className="text-[10px]">
              {readOnlyVault ? <Lock className="h-3 w-3" /> : null}
              {providerOriginText(provider.origin, hostKind)}
            </Badge>
            <span className="tnum text-[10px] text-muted-foreground">
              {provider.keys.length ? `${provider.keys.length} 个 Key` : '尚未配置 Key'}
            </span>
            <span className="text-[10px] text-muted-foreground" title="本地适配规则版本">
              适配版本{' '}
              <span className="font-mono text-secondary-foreground">
                {provider.adapterVersion ?? DEFAULT_ADAPTER_VERSION}
              </span>
            </span>
            <ProtocolBadges protocols={provider.protocols} />
            {provider.rpm > 0 ? (
              <span className="tnum text-[10px] text-muted-foreground">{provider.rpm} RPM</span>
            ) : null}
            {provider.ruleUpdate ? (
              <button
                type="button"
                onClick={onApplyRuleUpdate}
                className="inline-flex items-center gap-1 rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning transition-colors hover:bg-warning/20"
                title={provider.ruleUpdate.updatedAt ? `规则更新于 ${provider.ruleUpdate.updatedAt}` : undefined}
              >
                <ArrowUpCircle className="h-3 w-3" />
                可升级至 {provider.ruleUpdate.remoteVersion}
              </button>
            ) : null}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {provider.keys.map((key) => {
              const editable = !(vaultClient && key.source === 'vault')
              return (
                <span
                  key={key.label}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card pl-2.5 pr-0.5 transition-colors hover:border-primary/30"
                >
                  <span className="font-mono text-[11px] font-medium text-foreground">
                    {key.label}
                  </span>
                  <span className="text-[10px] text-border" aria-hidden="true">
                    ·
                  </span>
                  <span className={cn('text-[10px] font-medium', sourceTextClass(key.source))}>
                    {sourceLabel[key.source]}
                  </span>
                  {key.projectId ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-violet/10 px-1.5 py-0.5 text-[9px] font-medium text-violet"
                      title={`GCP ${key.projectId} (${key.location ?? 'global'})`}
                    >
                      <Globe2 className="h-2.5 w-2.5" />
                      {key.projectId}
                    </span>
                  ) : null}
                  {editable ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onEditKey(key.label)}
                      title={`编辑 ${key.label}`}
                      aria-label={`编辑 ${key.label}`}
                      className="h-6 w-6 text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  ) : (
                    <span
                      className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground/70"
                      title="由中枢同步，需在 EdgeOne 中枢管理；本地可删除"
                      aria-label="由中枢同步，只读"
                    >
                      <Lock className="h-3 w-3" />
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onDeleteKey(key.label)}
                    title={`删除 ${key.label}`}
                    aria-label={`删除 ${key.label}`}
                    className="h-6 w-6 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              )
            })}

            <button
              type="button"
              onClick={onAddKey}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Plus className="h-3.5 w-3.5" />
              添加 Key
            </button>
          </div>
        </div>

        <div className="order-last flex w-full items-center justify-end gap-1 sm:order-none sm:w-auto sm:pt-0.5">
          <Button
            variant="secondary"
            size="icon-sm"
            onClick={onEdit}
            title={readOnlyVault ? '查看中枢供应商（只读）' : '编辑供应商'}
            aria-label="编辑供应商"
            className="text-muted-foreground"
          >
            {readOnlyVault ? <Lock className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="secondary"
            size="icon-sm"
            onClick={onDelete}
            title="删除供应商"
            aria-label="删除供应商"
            className="text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
