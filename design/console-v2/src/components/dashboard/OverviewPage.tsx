import type {
  AgentModel,
  HostKind,
  KbCandidate,
  OverviewStats,
  Provider,
} from '@/types'
import { Badge, PageHeader } from '@/components/ui/primitives'
import { HOST_CAPABILITIES } from '@/lib/host'
import { AgentOverview } from '@/components/dashboard/AgentOverview'
import { GatewayCard } from '@/components/dashboard/GatewayCard'
import { KbOverview } from '@/components/dashboard/KbOverview'
import { ErrorLogTable } from '@/components/dashboard/ErrorLogTable'

export function OverviewPage({
  stats,
  gatewayBaseUrl,
  clientKey,
  models,
  kbCandidates,
  providers,
  runMode,
  hostKind,
  onCopied,
}: {
  stats: OverviewStats
  gatewayBaseUrl: string
  clientKey: string
  models: AgentModel[]
  kbCandidates: KbCandidate[]
  providers: Provider[]
  runMode: 'agent' | 'kb'
  hostKind: HostKind
  onCopied: (message: string) => void
}) {
  const capabilities = HOST_CAPABILITIES[hostKind]
  const edgeOne = hostKind === 'edgeone'
  const kbAvailable = capabilities.runModes.includes('kb')

  return (
    <div>
      <PageHeader
        title="概览"
        description={
          edgeOne
            ? '查看边缘网关接入信息、Agent Key 当前状态与对外模型。'
            : '查看网关接入信息、Agent 与知识库运行状态，以及最近的错误日志。'
        }
        actions={
          <Badge tone={runMode === 'kb' ? 'info' : 'primary'}>
            {runMode === 'kb' ? '知识库模式' : 'Agent 模式'}
          </Badge>
        }
      />

      <div className="space-y-4">
        <GatewayCard
          baseUrl={gatewayBaseUrl}
          clientKey={clientKey}
          clientKeyReadOnly={edgeOne}
          runMode={runMode}
          models={models}
          kbCandidates={kbCandidates}
          providers={providers}
          onCopied={onCopied}
        />
        <AgentOverview
          stats={stats}
          snapshotProviders={edgeOne ? providers : undefined}
        />
        {kbAvailable ? <KbOverview stats={stats} /> : null}
        {capabilities.logs ? <ErrorLogTable logs={stats.logs} /> : null}
      </div>
    </div>
  )
}
