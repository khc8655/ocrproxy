import { useState } from 'react'
import { Layers, Pencil, Plus, Trash2, Zap } from 'lucide-react'
import type { KbCandidate, ModelCategory, Provider } from '@/types'
import { Badge, Button, Card } from '@/components/ui/primitives'
import { HealthBadge, SourceBadge } from '@/components/common/badges'
import { categoryLabels } from '@/components/common/semantics'
import { CandidateDialog } from '@/components/models/CandidateDialog'
import { OrderInput } from '@/components/models/OrderInput'
import { cn, formatLatency } from '@/lib/utils'
import { useToast } from '@/components/ui/toast-context'

const KB_ORDER: ModelCategory[] = ['chat', 'embedding', 'reranker', 'ocr']

const categoryHint: Record<ModelCategory, string> = {
  chat: '关键词抽取、摘要与问答',
  embedding: '文档与查询向量化',
  reranker: '召回结果语义重排',
  ocr: '图片与扫描件文字识别',
}

export function KbModelsSection({
  candidates,
  providers,
  probing,
  runMode,
  onAdd,
  onUpdate,
  onDelete,
  onReorder,
  onProbe,
}: {
  candidates: KbCandidate[]
  providers: Provider[]
  probing: Set<string>
  runMode: 'agent' | 'kb'
  onAdd: (candidates: KbCandidate[]) => void
  onUpdate: (candidate: KbCandidate) => void
  onDelete: (candidateId: string) => void
  onReorder: (category: ModelCategory, from: number, to: number) => void
  onProbe: (candidate: KbCandidate) => Promise<number>
}) {
  const { toast } = useToast()
  const [dialogCategory, setDialogCategory] = useState<ModelCategory>('chat')
  const [editing, setEditing] = useState<KbCandidate | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  function openDialog(category: ModelCategory, candidate: KbCandidate | null) {
    setDialogCategory(category)
    setEditing(candidate)
    setDialogOpen(true)
  }

  async function handleProbe(candidate: KbCandidate) {
    const latency = await onProbe(candidate)
    toast({
      title: '节点探测通过',
      description: `${candidate.providerId} / ${candidate.keyLabel} · ${formatLatency(latency)}`,
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-secondary/30 px-3.5 py-2.5 text-[11px] text-secondary-foreground">
        <Badge tone={runMode === 'kb' ? 'info' : 'neutral'}>
          {runMode === 'kb' ? '当前运行：知识库' : '当前运行：Agent'}
        </Badge>
        <span>
          知识库固定暴露 4 个虚拟模型，每个模型下按序号挂载候选节点，故障时自动顺延。
        </span>
      </div>

      {KB_ORDER.map((category) => {
        const list = candidates.filter((candidate) => candidate.category === category)
        return (
          <Card key={category} className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">
                    {categoryLabels[category]}
                  </h3>
                  <Badge tone="neutral" className="font-mono text-[10px]">
                    model=&quot;{category}&quot;
                  </Badge>
                  <span className="tnum text-[10px] text-muted-foreground">
                    {list.length} 个候选节点
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {categoryHint[category]}
                  {list.length > 1 ? ' · 输入序号调整故障切换顺序' : ''}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openDialog(category, null)}
              >
                <Plus className="h-3.5 w-3.5" />
                挂载节点
              </Button>
            </div>

            {list.length ? (
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[820px] border-collapse text-left">
                  <thead>
                    <tr className="bg-secondary/40 text-[11px] text-muted-foreground">
                      <th
                        className="w-16 px-4 py-2 text-center font-medium"
                        title="输入 1 到列表长度的序号调整顺序"
                      >
                        顺序
                      </th>
                      <th className="px-3 py-2 font-medium">供应商</th>
                      <th className="px-3 py-2 font-medium">Key 别名</th>
                      <th className="px-3 py-2 font-medium">来源</th>
                      <th className="px-3 py-2 font-medium">上游实际模型</th>
                      <th className="px-3 py-2 font-medium">状态</th>
                      <th className="px-3 py-2 font-medium">最近调用</th>
                      <th className="px-5 py-2 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((candidate, index) => {
                      const provider = providers.find(
                        (item) => item.id === candidate.providerId,
                      )
                      const key = provider?.keys.find(
                        (item) => item.label === candidate.keyLabel,
                      )
                      const probeId = `kb:${candidate.id}`
                      const isProbing = probing.has(probeId)
                      return (
                        <tr
                          key={candidate.id}
                          className={cn(
                            'border-t border-border text-xs transition-colors hover:bg-secondary/30',
                            index === 0 && 'bg-primary/[0.03]',
                          )}
                        >
                          <td className="w-16 px-4 py-2.5">
                            <div className="flex justify-center">
                              <OrderInput
                                key={`${candidate.id}:${index}`}
                                index={index}
                                total={list.length}
                                active={index === 0}
                                onCommit={(next) => onReorder(category, index, next)}
                              />
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <p className="truncate text-xs font-medium text-foreground">
                              {provider?.name ?? candidate.providerId}
                            </p>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className="rounded-md border border-border bg-secondary px-2 py-0.5 font-mono text-[11px] font-medium text-secondary-foreground">
                              {candidate.keyLabel}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            {key ? (
                              <SourceBadge source={key.source} />
                            ) : (
                              <Badge tone="danger">缺失</Badge>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <span
                              className="block max-w-[220px] truncate font-mono text-[11px] text-foreground"
                              title={candidate.upstreamModel}
                            >
                              {candidate.upstreamModel}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            {key ? (
                              <HealthBadge
                                health={key.health}
                                latencyMs={key.latencyMs}
                                showDot
                              />
                            ) : (
                              <Badge tone="danger">Key 不存在</Badge>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-[11px] text-muted-foreground">
                            {key?.lastUsed ?? '—'}
                          </td>
                          <td className="px-5 py-2.5">
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => void handleProbe(candidate)}
                                loading={isProbing}
                                disabled={!key}
                                title="发送一次真实小请求测试连通性"
                                className="h-7 px-2"
                              >
                                {isProbing ? null : <Zap className="h-3.5 w-3.5" />}
                                测
                              </Button>
                              <Button
                                variant="secondary"
                                size="icon-sm"
                                onClick={() => openDialog(category, candidate)}
                                title="编辑节点"
                                aria-label="编辑节点"
                                className="h-7 w-7 text-muted-foreground"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="secondary"
                                size="icon-sm"
                                onClick={() => {
                                  onDelete(candidate.id)
                                  toast({
                                    title: '节点已删除',
                                    description: `${candidate.providerId} / ${candidate.keyLabel} 已移除`,
                                    variant: 'info',
                                  })
                                }}
                                title="删除节点"
                                aria-label="删除节点"
                                className="h-7 w-7 text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 border-t border-border px-5 py-6 text-center">
                <Layers className="h-4 w-4 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  还没有挂载候选节点，入库请求会直接失败。
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openDialog(category, null)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  挂载第一个节点
                </Button>
              </div>
            )}
          </Card>
        )
      })}

      <CandidateDialog
        open={dialogOpen}
        category={dialogCategory}
        editing={editing}
        providers={providers}
        onOpenChange={(next) => {
          setDialogOpen(next)
          if (!next) setEditing(null)
        }}
        onAdd={(next) => {
          onAdd(next)
          toast({
            title: '节点已挂载',
            description: `${next.length} 个候选已加入 ${categoryLabels[dialogCategory]} 模型`,
          })
        }}
        onUpdate={(candidate) => {
          onUpdate(candidate)
          toast({
            title: '节点已更新',
            description: `${candidate.providerId} / ${candidate.keyLabel} 的模型与 Key 已保存`,
          })
        }}
      />
    </div>
  )
}
