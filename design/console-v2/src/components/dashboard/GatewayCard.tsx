import type { AgentModel, KbCandidate, Provider } from '@/types'
import { Badge, SectionCard } from '@/components/ui/primitives'
import { CopyButton } from '@/components/common/CopyButton'
import { ProtocolBadges } from '@/components/common/badges'
import { categoryLabels } from '@/components/common/semantics'

const KB_ORDER = ['chat', 'embedding', 'reranker', 'ocr'] as const

export function GatewayCard({
  baseUrl,
  clientKey,
  clientKeyReadOnly,
  runMode,
  models,
  kbCandidates,
  providers,
  onCopied,
}: {
  baseUrl: string
  clientKey: string
  clientKeyReadOnly?: boolean
  runMode: 'agent' | 'kb'
  models: AgentModel[]
  kbCandidates: KbCandidate[]
  providers: Provider[]
  onCopied: (message: string) => void
}) {
  return (
    <SectionCard title="接入网关与可用模型" contentClassName="p-0">
      <div className="divide-y divide-border">
        <div className="flex items-center gap-3 px-5 py-3">
          <span className="w-32 shrink-0 text-[11px] font-medium text-muted-foreground">
            Base URL（网关地址）
          </span>
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-secondary-foreground">
            {baseUrl}
          </code>
          <CopyButton
            text={baseUrl}
            label="复制 URL"
            variant="secondary"
            size="sm"
            onCopied={() => onCopied('已复制 Base URL')}
            className="h-7 px-2.5 text-[11px]"
          />
        </div>

        <div className="flex items-center gap-3 px-5 py-3">
          <span className="w-32 shrink-0 text-[11px] font-medium text-muted-foreground">
            客户端凭据（Key）
          </span>
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-secondary-foreground">
            {clientKey || '由环境变量注入'}
          </code>
          {clientKey ? (
            <CopyButton
              text={clientKey}
              label="复制 Key"
              variant="secondary"
              size="sm"
              onCopied={() => onCopied('已复制客户端 Key')}
              className="h-7 px-2.5 text-[11px]"
            />
          ) : null}
          {clientKeyReadOnly ? <Badge tone="info">环境变量</Badge> : null}
        </div>

        <div className="flex items-start gap-3 px-5 py-3">
          <span className="w-32 shrink-0 pt-1 text-[11px] font-medium text-muted-foreground">
            可用模型
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {runMode === 'agent' ? (
              models.length ? (
                models.map((model) => (
                  <CopyButton
                    key={model.id}
                    text={model.id}
                    variant="secondary"
                    size="sm"
                    onCopied={() => onCopied(`已复制模型名 ${model.id}`)}
                    className="h-8 gap-2 rounded-full px-2.5 text-[10px]"
                  >
                    <span className="font-mono font-medium">{model.id}</span>
                    <span className="text-muted-foreground">
                      {model.bindings.length} Key
                    </span>
                    {model.protocols.length ? (
                      <ProtocolBadges protocols={model.protocols} />
                    ) : null}
                  </CopyButton>
                ))
              ) : (
                <p className="pt-1 text-[11px] text-muted-foreground">
                  暂无 Agent 模型，添加模型后会在这里出现。
                </p>
              )
            ) : (
              KB_ORDER.map((category) => {
                const nodes = kbCandidates.filter(
                  (candidate) => candidate.category === category,
                )
                const protocols = Array.from(
                  new Set(
                    nodes.flatMap((node) => {
                      const provider = providers.find(
                        (item) => item.id === node.providerId,
                      )
                      return provider?.protocols ?? []
                    }),
                  ),
                )
                return (
                  <CopyButton
                    key={category}
                    text={category}
                    variant="secondary"
                    size="sm"
                    onCopied={() => onCopied(`已复制模型名 ${category}`)}
                    className="h-8 gap-2 rounded-full px-2.5 text-[10px]"
                  >
                    <span className="font-mono font-medium">{category}</span>
                    <span className="text-muted-foreground">
                      {categoryLabels[category]} ·{' '}
                      {nodes.length ? `${nodes.length} 节点` : '未挂载'}
                    </span>
                    {nodes.length ? <ProtocolBadges protocols={protocols} /> : null}
                  </CopyButton>
                )
              })
            )}
          </div>
        </div>
      </div>
    </SectionCard>
  )
}
