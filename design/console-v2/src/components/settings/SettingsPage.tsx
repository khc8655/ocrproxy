import { useState, type ReactNode } from 'react'
import { AlertTriangle, Eye, EyeOff, RefreshCw, Save } from 'lucide-react'
import { settingGroups } from '@/data/mock'
import type { HostKind, SettingField, SettingGroup } from '@/types'
import { Button, Card, Input, PageHeader } from '@/components/ui/primitives'
import { CopyButton } from '@/components/common/CopyButton'
import { useToast } from '@/components/ui/toast-context'
import { SettingRow } from '@/components/settings/SettingRow'
import { OpsPanel } from '@/components/settings/OpsPanel'
import { BackupPanel } from '@/components/settings/BackupPanel'
import type { ImportMode, SettingValue } from '@/hooks/useConsole'
import { HOST_CAPABILITIES } from '@/lib/host'
import { randomClientKey } from '@/lib/utils'

function ClientKeyRow({
  value,
  onChange,
  onCopied,
  readOnly,
}: {
  value: string
  onChange: (next: string) => void
  onCopied: (message: string) => void
  readOnly: boolean
}) {
  const [revealed, setRevealed] = useState(false)
  const { toast } = useToast()

  return (
    <div className="flex flex-col gap-2 border-b border-border py-2.5 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">客户端调用密钥（PROXY_API_KEY）</p>
        <p className="text-[10px] leading-4 text-muted-foreground">
          {readOnly
            ? 'EdgeOne 运行时从控制台环境变量注入，页面内只读，避免覆盖后失效'
            : 'Cursor / Cline / Dify 调用 /v1/* 时使用的 Bearer 密钥'}
        </p>
      </div>
      <div className="flex w-full items-center gap-1.5 sm:w-auto">
        <div className="relative min-w-0 flex-1 sm:w-[250px]">
          <Input
            type={revealed ? 'text' : 'password'}
            value={value}
            readOnly={readOnly}
            onChange={(event) => onChange(event.target.value)}
            className="h-8 pr-8 font-mono text-xs read-only:bg-secondary"
            aria-label="客户端调用密钥"
          />
          <button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-label={revealed ? '隐藏密钥' : '显示密钥'}
          >
            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        {!readOnly ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onChange(randomClientKey())
              setRevealed(true)
              toast({
                title: '已生成新的客户端 Key',
                description: '保存设置后旧 Key 立即失效',
                variant: 'info',
              })
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            随机生成
          </Button>
        ) : null}
        <CopyButton
          text={value}
          label="复制"
          variant="secondary"
          size="sm"
          onCopied={() => onCopied('已复制客户端 Key')}
        />
      </div>
    </div>
  )
}

function InlineHint({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 rounded-xl border border-dashed border-border bg-secondary/40 px-3 py-2 text-[11px] leading-5 text-secondary-foreground">
      {children}
    </div>
  )
}

function fieldVisible(field: SettingField, hostKind: HostKind, runMode: 'agent' | 'kb') {
  if (field.hosts && !field.hosts.includes(hostKind)) return false
  if (field.modes && !field.modes.includes(runMode)) return false
  return true
}

function GroupSection({
  group,
  fields,
  values,
  hostKind,
  manual,
  onChange,
  onCopied,
  onSaveVault,
}: {
  group: SettingGroup
  fields: SettingField[]
  values: Record<string, SettingValue>
  hostKind: HostKind
  manual: boolean
  onChange: (key: string, value: SettingValue) => void
  onCopied: (message: string) => void
  onSaveVault: () => void
}) {
  const { toast } = useToast()
  const capabilities = HOST_CAPABILITIES[hostKind]
  const twoColumns = group.id !== 'vault'
  const isTimeoutGroup = group.id === 'timeout'
  const isConcurrencyGroup = group.id === 'concurrency'
  const isFaultGroup = group.id === 'fault'

  if ((isTimeoutGroup || isConcurrencyGroup) && manual) {
    return (
      <section className="px-4 py-2.5">
        <h2 className="text-xs font-semibold tracking-tight text-foreground">{group.title}</h2>
        <InlineHint>
          纯手动直通固定使用当前 Key，整单 300 秒超时，没有可调的超时、并发与队列参数。
        </InlineHint>
      </section>
    )
  }

  if (isFaultGroup && manual) {
    return (
      <section className="px-4 py-2.5">
        <h2 className="text-xs font-semibold tracking-tight text-foreground">{group.title}</h2>
        <InlineHint>
          手动直通不重试、不熔断、不冷却，上游响应 100% 原始透传。
        </InlineHint>
      </section>
    )
  }

  return (
    <section className="px-4 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h2 className="text-xs font-semibold tracking-tight text-foreground">
          {group.title}
        </h2>
        <p className="text-[10px] text-muted-foreground">{group.description}</p>
      </div>

      <div className={twoColumns ? 'mt-1 grid gap-x-10 sm:grid-cols-2' : 'mt-1'}>
        {group.id === 'access' ? (
          <ClientKeyRow
            value={String(values.proxy_api_key ?? '')}
            onChange={(next) => onChange('proxy_api_key', next)}
            onCopied={onCopied}
            readOnly={!capabilities.clientKeyEditable}
          />
        ) : null}
        {fields.map((field) => (
          <SettingRow
            key={field.key}
            field={field}
            value={values[field.key] ?? field.value}
            onChange={(next) => onChange(field.key, next)}
            fullWidth={group.id === 'vault'}
          />
        ))}
      </div>

      {group.id === 'routing' && manual ? (
        <InlineHint>
          <span className="inline-flex items-center gap-1 font-medium text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            纯手动直通已生效
          </span>
          <span className="mx-1.5 text-border">·</span>
          仅使用当前激活 Key，不重试、不切换、不熔断。
        </InlineHint>
      ) : null}

      {group.id === 'vault' ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
          <span
            className={
              values.vault_token
                ? 'rounded-full border border-success/20 bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success'
                : 'rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground'
            }
          >
            {values.vault_token ? '已配置凭证' : '尚未配置 Token'}
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onSaveVault()
              toast({
                title: '中枢配置已保存',
                description: '中枢地址与 Token 已单独保存，不参与整包配置版本冲突',
                variant: 'info',
              })
            }}
          >
            保存中枢配置
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              toast({
                title: '中枢连通正常',
                description: '已成功连接凭据中枢并读取规则版本',
                variant: 'info',
              })
            }
          >
            测试中枢连通性
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              toast({
                title: '增量同步完成',
                description: '中枢规则与只读凭证已更新到本地',
                variant: 'info',
              })
            }
          >
            增量同步中枢规则
          </Button>
          <span className="text-[10px] text-muted-foreground">
            修改地址或 Token 后先保存，再执行测试或同步
          </span>
        </div>
      ) : null}
    </section>
  )
}

export function SettingsPage({
  values,
  dirtyKeys,
  hostKind,
  runMode,
  onChange,
  onSave,
  onDiscard,
  onReset,
  onExport,
  onImport,
  rawConfig,
  onCopied,
  onSaveVault,
}: {
  values: Record<string, SettingValue>
  dirtyKeys: string[]
  hostKind: HostKind
  runMode: 'agent' | 'kb'
  onChange: (key: string, value: SettingValue) => void
  onSave: () => number
  onDiscard: () => void
  onReset: () => void
  onExport: () => void
  onImport: (payload: unknown, mode: ImportMode) => void
  rawConfig: string
  onCopied: (message: string) => void
  onSaveVault: () => void
}) {
  const { toast } = useToast()
  const capabilities = HOST_CAPABILITIES[hostKind]
  const activeRouting = String(
    runMode === 'kb'
      ? values.kb_routing_strategy ?? 'round_robin'
      : values.agent_routing_strategy ?? 'sticky_failover',
  )
  const manual = activeRouting === 'manual'

  const visibleGroups = settingGroups
    .filter((group) => !group.hosts || group.hosts.includes(hostKind))
    .map((group) => ({
      group,
      fields: group.fields.filter((field) => fieldVisible(field, hostKind, runMode)),
    }))
    .filter(({ group, fields }) => group.id === 'access' || fields.length > 0)

  function handleSave() {
    const count = onSave()
    toast({
      title: '设置已保存',
      description: count > 0 ? `${count} 项修改已立即生效` : '当前没有需要保存的修改',
    })
  }

  return (
    <div>
      <PageHeader
        title="系统设置"
        description={
          hostKind === 'edgeone'
            ? 'EdgeOne 固定 Agent 模式；客户端 Key 由控制台环境变量注入，页面内只读。'
            : '统一配置运行模式、分流策略、超时与容错参数，保存后立即生效。'
        }
        actions={
          <>
            {dirtyKeys.length ? (
              <Button variant="secondary" onClick={onDiscard}>
                放弃修改
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                onReset()
                toast({
                  title: '已恢复推荐默认值',
                  description: '可以继续微调后保存',
                  variant: 'info',
                })
              }}
            >
              恢复默认
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={!dirtyKeys.length}>
              <Save className="h-3.5 w-3.5" />
              保存修改{dirtyKeys.length ? `（${dirtyKeys.length}）` : ''}
            </Button>
          </>
        }
      />

      <Card className="divide-y divide-border overflow-hidden">
        {visibleGroups.map(({ group, fields }) => (
          <GroupSection
            key={group.id}
            group={group}
            fields={fields}
            values={values}
            hostKind={hostKind}
            manual={manual}
            onChange={onChange}
            onCopied={onCopied}
            onSaveVault={onSaveVault}
          />
        ))}
      </Card>

      <Card
        className={
          capabilities.systemUpdate
            ? 'mt-3 grid gap-5 px-4 py-3.5 lg:grid-cols-2'
            : 'mt-3 grid gap-5 px-4 py-3.5'
        }
      >
        {capabilities.systemUpdate ? <OpsPanel /> : null}
        <BackupPanel
          rawConfig={rawConfig}
          onExport={onExport}
          onImport={onImport}
          onCopied={onCopied}
        />
      </Card>
    </div>
  )
}
