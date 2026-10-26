import type {
  KeyHealth,
  KeySource,
  ModelCategory,
  Protocol,
  RoutingStrategy,
} from '@/types'

/* 全站语义色：同一含义在所有页面使用同一套颜色。
 * 协议：Chat 蓝 / Messages 紫 / Responses 青
 * 来源：中枢 蓝 / 本地 灰 / 免 Key 天蓝
 * 状态：正常 绿 / 未调用 灰 / 限流 橙 / 异常与欠费 红
 */

export type ProtocolTone = 'primary' | 'violet' | 'teal'
export type SourceTone = 'neutral' | 'primary' | 'info'
export type HealthTone = 'success' | 'neutral' | 'warning' | 'danger'

export const protocolLabels: Record<Protocol, string> = {
  chat: 'Chat',
  messages: 'Messages',
  responses: 'Responses',
}

export const protocolOptions: { value: Protocol; label: string }[] = [
  { value: 'chat', label: protocolLabels.chat },
  { value: 'messages', label: protocolLabels.messages },
  { value: 'responses', label: protocolLabels.responses },
]

export const protocolTone: Record<Protocol, ProtocolTone> = {
  chat: 'primary',
  messages: 'violet',
  responses: 'teal',
}

const protocolSelected: Record<Protocol, string> = {
  chat: 'border-primary/40 bg-primary/10 text-primary',
  messages: 'border-violet/40 bg-violet/10 text-violet',
  responses: 'border-teal/40 bg-teal/10 text-teal',
}

export function protocolSelectedClass(protocol: Protocol) {
  return protocolSelected[protocol]
}

export const sourceLabel: Record<KeySource, string> = {
  local: '本地',
  vault: '中枢',
  public: '免 Key',
}

export function providerOriginText(origin: 'local' | 'vault', host: 'vm' | 'edgeone') {
  if (origin === 'local') return host === 'edgeone' ? '本地自建' : '本地配置'
  return host === 'edgeone' ? '中枢统一' : '来自中枢'
}

export const providerOriginTone: Record<'local' | 'vault', SourceTone> = {
  local: 'neutral',
  vault: 'primary',
}

export const sourceTone: Record<KeySource, SourceTone> = {
  local: 'neutral',
  vault: 'primary',
  public: 'info',
}

const sourceText: Record<KeySource, string> = {
  local: 'text-secondary-foreground',
  vault: 'text-primary',
  public: 'text-info',
}

export function sourceTextClass(source: KeySource) {
  return sourceText[source]
}

export const healthLabel: Record<KeyHealth, string> = {
  ok: '正常',
  idle: '未调用',
  rate_limited: '429 限流',
  error: '异常',
  quota: '欠费',
}

export const healthTone: Record<KeyHealth, HealthTone> = {
  ok: 'success',
  idle: 'neutral',
  rate_limited: 'warning',
  error: 'danger',
  quota: 'danger',
}

export const categoryLabels: Record<ModelCategory, string> = {
  chat: '对话',
  embedding: '向量',
  reranker: '重排',
  ocr: 'OCR',
}

export const routingLabel: Record<RoutingStrategy, string> = {
  sticky_failover: '粘性故障转移',
  round_robin: '轮询负载',
  manual: '手动直通',
}

export const routingHint: Record<RoutingStrategy, string> = {
  sticky_failover: '固定当前 Key，遇错自动顺延',
  round_robin: '按请求轮流分配到各个 Key',
  manual: '仅使用当前主力 Key，不自动切换',
}

export const logCategoryTone: Record<'Agent' | 'KB', 'primary' | 'info'> = {
  Agent: 'primary',
  KB: 'info',
}
