import { useState } from 'react'
import { Plus, Route, ShieldCheck } from 'lucide-react'
import type {
  AgentModel,
  Binding,
  HostKind,
  KbCandidate,
  ModelCategory,
  Provider,
  RoutingStrategy,
} from '@/types'
import { Badge, Button, EmptyState, PageHeader, Segmented } from '@/components/ui/primitives'
import { ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast-context'
import { ModelCard } from '@/components/models/ModelCard'
import { ModelDialog } from '@/components/models/ModelDialog'
import { KbModelsSection } from '@/components/models/KbModelsSection'
import { routingHint, routingLabel } from '@/components/common/semantics'
import { HOST_CAPABILITIES } from '@/lib/host'
import { formatLatency } from '@/lib/utils'

type ModelTab = 'agent' | 'kb'

export function ModelsPage({
  models,
  kbCandidates,
  providers,
  probing,
  hostKind,
  runMode,
  agentRouting,
  kbRouting,
  onAddModel,
  onUpdateModel,
  onDeleteModel,
  onSetActive,
  onRemoveBinding,
  onReorderBindings,
  onProbe,
  onAddKbCandidates,
  onUpdateKbCandidate,
  onDeleteKbCandidate,
  onReorderKbCandidates,
  onProbeKbCandidate,
}: {
  models: AgentModel[]
  kbCandidates: KbCandidate[]
  providers: Provider[]
  probing: Set<string>
  hostKind: HostKind
  runMode: 'agent' | 'kb'
  agentRouting: string
  kbRouting: string
  onAddModel: (model: AgentModel) => void
  onUpdateModel: (model: AgentModel) => void
  onDeleteModel: (modelId: string) => void
  onSetActive: (modelId: string, binding: Binding) => void
  onRemoveBinding: (modelId: string, binding: Binding) => void
  onReorderBindings: (modelId: string, from: number, to: number) => void
  onProbe: (modelId: string, binding: Binding) => Promise<number>
  onAddKbCandidates: (candidates: KbCandidate[]) => void
  onUpdateKbCandidate: (candidate: KbCandidate) => void
  onDeleteKbCandidate: (candidateId: string) => void
  onReorderKbCandidates: (category: ModelCategory, from: number, to: number) => void
  onProbeKbCandidate: (candidate: KbCandidate) => Promise<number>
}) {
  const { toast } = useToast()
  const [tab, setTab] = useState<ModelTab>('agent')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AgentModel | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AgentModel | null>(null)

  const kbAvailable = HOST_CAPABILITIES[hostKind].runModes.includes('kb')
  const activeTab: ModelTab = kbAvailable ? tab : 'agent'
  const agentStrategy = (agentRouting as RoutingStrategy) in routingLabel
    ? (agentRouting as RoutingStrategy)
    : 'sticky_failover'
  const kbStrategy = (kbRouting as RoutingStrategy) in routingLabel
    ? (kbRouting as RoutingStrategy)
    : 'round_robin'

  function handleSave(model: AgentModel, isEdit: boolean): boolean {
    const collision = models.find(
      (item) =>
        item.id.toLowerCase() === model.id.toLowerCase() &&
        (!isEdit || item.id !== editing?.id),
    )
    if (collision) {
      toast({
        title: '模型 ID 已存在',
        description: `「${collision.id}」已在路由列表中，请换一个名称。`,
        variant: 'error',
      })
      return false
    }
    if (isEdit) {
      onUpdateModel(model)
      toast({ title: '模型已更新', description: `${model.id} 的路由配置已生效` })
    } else {
      onAddModel(model)
      toast({
        title: '模型已创建',
        description: `${model.id} 已加入对外模型列表`,
      })
    }
    setEditing(null)
    return true
  }

  async function handleProbe(modelId: string, binding: Binding) {
    const latency = await onProbe(modelId, binding)
    toast({
      title: '探测通过',
      description: `${binding.providerId} / ${binding.keyLabel} · ${formatLatency(latency)}`,
    })
  }

  return (
    <div>
      <PageHeader
        title="模型及路由"
        description={
          activeTab === 'agent'
            ? '以模型为单位管理 Key 绑定，在列表中切换主力 Key、输入序号调整顺序或探测连通性。'
            : '知识库固定 4 个虚拟模型，以节点为单位挂载供应商 Key 与上游模型。'
        }
        actions={
          activeTab === 'agent' ? (
            <Button
              variant="primary"
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              新增 Agent 模型
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {kbAvailable ? (
          <Segmented
            value={activeTab}
            onChange={setTab}
            options={[
              { label: 'Agent 路由', value: 'agent', count: models.length },
              { label: '知识库', value: 'kb', count: 4 },
            ]}
          />
        ) : (
          <Badge tone="primary" className="px-2.5 py-1">
            <ShieldCheck className="h-3 w-3" />
            EdgeOne 边缘版固定 Agent 路由
          </Badge>
        )}
      </div>

      {activeTab === 'agent' ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-secondary/30 px-3.5 py-2.5 text-[11px]">
            <span className="font-medium text-secondary-foreground">
              {routingLabel[agentStrategy]}
            </span>
            <span className="text-muted-foreground">{routingHint[agentStrategy]}</span>
            <span className="ml-auto text-muted-foreground">
              在「系统设置」中调整 Agent 分流策略
            </span>
          </div>

          {models.length ? (
            <div className="space-y-4">
              {models.map((model) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  providers={providers}
                  probing={probing}
                  onEdit={() => {
                    setEditing(model)
                    setDialogOpen(true)
                  }}
                  onDelete={() => setDeleteTarget(model)}
                  onProbe={(binding) => {
                    void handleProbe(model.id, binding)
                  }}
                  onSetActive={(binding) => {
                    onSetActive(model.id, binding)
                    toast({
                      title: '已切换主力 Key',
                      description: `${binding.providerId} / ${binding.keyLabel} 将优先承接请求`,
                      variant: 'info',
                    })
                  }}
                  onRemoveBinding={(binding) => {
                    onRemoveBinding(model.id, binding)
                    toast({
                      title: '绑定已移除',
                      description: `${binding.providerId} / ${binding.keyLabel} 不再参与该模型路由`,
                      variant: 'info',
                    })
                  }}
                  onReorderBindings={(from, to) => {
                    if (from === to) return
                    onReorderBindings(model.id, from, to)
                    toast({
                      title: 'Key 顺序已更新',
                      description: '故障转移会按新顺序依次尝试',
                      variant: 'info',
                    })
                  }}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Route className="h-5 w-5" />}
              title="还没有 Agent 模型"
              description="新建模型后即可绑定供应商 Key，对外提供统一的模型名。"
              action={
                <Button variant="primary" onClick={() => setDialogOpen(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  新增模型
                </Button>
              }
            />
          )}
        </>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-secondary/30 px-3.5 py-2.5 text-[11px]">
            <span className="font-medium text-secondary-foreground">
              {routingLabel[kbStrategy]}
            </span>
            <span className="text-muted-foreground">{routingHint[kbStrategy]}</span>
            <span className="ml-auto text-muted-foreground">
              在「系统设置」中调整知识库分流策略
            </span>
          </div>

          <KbModelsSection
            candidates={kbCandidates}
            providers={providers}
            probing={probing}
            runMode={runMode}
            onAdd={onAddKbCandidates}
            onUpdate={onUpdateKbCandidate}
            onDelete={onDeleteKbCandidate}
            onReorder={onReorderKbCandidates}
            onProbe={onProbeKbCandidate}
          />
        </>
      )}

      <ModelDialog
        open={dialogOpen}
        onOpenChange={(next) => {
          setDialogOpen(next)
          if (!next) setEditing(null)
        }}
        editing={editing}
        providers={providers}
        onSave={handleSave}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null)
        }}
        title={`删除模型「${deleteTarget?.id ?? ''}」？`}
        description="删除后该模型名将立即从网关下线，正在使用它的客户端会收到模型不存在。"
        confirmLabel="确认删除"
        onConfirm={() => {
          if (!deleteTarget) return
          onDeleteModel(deleteTarget.id)
          toast({
            title: '模型已删除',
            description: `${deleteTarget.id} 已从对外模型列表移除`,
            variant: 'info',
          })
          setDeleteTarget(null)
        }}
      />
    </div>
  )
}
