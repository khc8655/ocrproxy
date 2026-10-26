export type PageId = 'overview' | 'providers' | 'models' | 'settings'

export type HostKind = 'vm' | 'edgeone'

export type Protocol = 'chat' | 'messages' | 'responses'

export type KeySource = 'local' | 'vault' | 'public'

export type KeyHealth = 'ok' | 'idle' | 'rate_limited' | 'error' | 'quota'

export type RoutingStrategy = 'sticky_failover' | 'round_robin' | 'manual'

export type ModelCategory = 'chat' | 'embedding' | 'reranker' | 'ocr'

export interface ProviderKey {
  label: string
  masked: string
  source: KeySource
  health: KeyHealth
  latencyMs?: number | null
  lastUsed?: string
  projectId?: string
  location?: string
}

export interface ProviderRuleUpdate {
  remoteVersion: string
  updatedAt: string
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  anthropicBaseUrl?: string
  rpm: number
  origin: 'local' | 'vault'
  adapterVersion: string
  protocols: Protocol[]
  description: string
  keys: ProviderKey[]
  ruleUpdate?: ProviderRuleUpdate | null
}

export interface Binding {
  providerId: string
  keyLabel: string
}

export interface AgentModel {
  id: string
  upstreamModel?: string
  protocols: Protocol[]
  category: 'chat'
  activeKey: string
  bindings: Binding[]
}

export interface KbCandidate {
  id: string
  category: ModelCategory
  providerId: string
  keyLabel: string
  upstreamModel: string
}

export interface ErrorLog {
  id: string
  time: string
  category: 'Agent' | 'KB'
  model: string
  provider: string
  keyLabel: string
  status: number
  detail: string
}

export interface ModelShare {
  name: string
  requests: number
}

export interface KbStat {
  count: number
  success: number
  errors: number
}

export interface OverviewStats {
  requests: number
  failures: number
  failovers: number
  ttftMs: number
  totalMsAvg: number
  tokensIn: number
  tokensOut: number
  modelShare: ModelShare[]
  kb: {
    chat: KbStat
    embedding: KbStat
    reranker: KbStat
    ocr: KbStat
  }
  logs: ErrorLog[]
}

export type SettingFieldType =
  | 'text'
  | 'password'
  | 'number'
  | 'select'
  | 'switch'
  | 'time'

export interface SelectOption {
  label: string
  value: string
}

export interface SettingField {
  key: string
  label: string
  hint?: string
  type: SettingFieldType
  value: string | number | boolean
  unit?: string
  min?: number
  max?: number
  options?: SelectOption[]
  mono?: boolean
  advanced?: boolean
  hosts?: HostKind[]
  modes?: Array<'agent' | 'kb'>
}

export interface SettingGroup {
  id: string
  title: string
  description: string
  fields: SettingField[]
  hosts?: HostKind[]
}
