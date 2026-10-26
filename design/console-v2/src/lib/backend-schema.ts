/**
 * 后端 Schema ↔ Console v2 类型适配。
 *
 * 关键原则：
 * 1. 读取时只把后端配置投影成 UI 需要的形状；真实 Key 不进入 UI 状态。
 * 2. 写回时以原始 config 为底稿，只更新 UI 管理的字段，保留未知字段与真实 Key。
 * 3. 不把 masked Key 当作真实 Key 写回；新 Key 的明文录入由 KeyDialog 后续接入。
 */
import type {
  AgentModel,
  Binding,
  KbCandidate,
  ModelCategory,
  Provider,
  ProviderKey,
  SettingValue,
} from '@/types'
import { DEFAULT_ADAPTER_VERSION } from '@/lib/constants'

type Dict = Record<string, unknown>

const isRecord = (value: unknown): value is Dict =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

function maskKey(value: unknown): string {
  if (typeof value !== 'string' || !value) return '••••••••'
  if (value.includes('•')) return value
  return value.length <= 8 ? '••••••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`
}

function protocolsOf(raw: Dict): Array<'chat' | 'messages' | 'responses'> {
  const list = Array.isArray(raw.protocols) ? raw.protocols : [raw.protocol]
  const valid = list.filter(
    (item): item is 'chat' | 'messages' | 'responses' =>
      item === 'chat' || item === 'messages' || item === 'responses',
  )
  return valid.length ? valid : ['chat']
}

function providerKeysOf(raw: Dict): ProviderKey[] {
  const keys = isRecord(raw.keys) ? raw.keys : {}
  return Object.entries(keys).map(([label, value]) => {
    const item = isRecord(value) ? value : { key: value }
    const source = item.origin === 'vault' || item.is_local === false ? 'vault' : 'local'
    return {
      // 后端列表返回的是 masked 字符串；不把真实值带进 UI 状态。
      label,
      masked: maskKey(item.key),
      source,
      health: 'idle',
      latencyMs: null,
    }
  })
}

export function providersFromBackend(config: Dict): Provider[] {
  const providers = isRecord(config.providers) ? config.providers : {}
  return Object.entries(providers)
    .filter(([, value]) => isRecord(value))
    .map(([id, value]) => {
      const raw = value as Dict
      const origin = raw.origin === 'vault' || raw.origin === 'local' ? raw.origin : 'local'
      return {
        id,
        name: asString(raw.name, id),
        baseUrl: asString(raw.base_url),
        anthropicBaseUrl: asString(raw.anthropic_base_url) || undefined,
        rpm: asNumber(raw.rpm_limit ?? raw.rpm),
        origin,
        adapterVersion: asString(raw.adapter_version ?? raw.version, DEFAULT_ADAPTER_VERSION),
        protocols: protocolsOf(raw),
        description: asString(raw.description),
        keys: providerKeysOf(raw),
        ruleUpdate: null,
      }
    })
}

export function modelsFromBackend(config: Dict): AgentModel[] {
  const models = isRecord(config.agent_models) ? config.agent_models : {}
  return Object.entries(models)
    .filter(([, value]) => isRecord(value))
    .map(([id, value]) => {
      const raw = value as Dict
      const bindings: Binding[] = (Array.isArray(raw.keys) ? raw.keys : [])
        .filter(isRecord)
        .map((item) => ({
          providerId: asString(item.provider),
          keyLabel: asString(item.key ?? item.key_label),
        }))
        .filter((item) => item.providerId && item.keyLabel)
      return {
        id,
        upstreamModel: asString(raw.upstream_model) || undefined,
        protocols: ['chat'],
        category: 'chat',
        activeKey: asString(raw.active_key),
        bindings,
      }
    })
}

const KB_CATEGORIES: ModelCategory[] = ['chat', 'embedding', 'reranker', 'ocr']

export function kbCandidatesFromBackend(config: Dict): KbCandidate[] {
  const candidates = isRecord(config.candidates) ? config.candidates : {}
  return KB_CATEGORIES.flatMap((category) => {
    const list = Array.isArray(candidates[category]) ? candidates[category] : []
    return list.filter(isRecord).map((item) => ({
      id: `${category}:${asString(item.provider)}:${asString(item.key)}:${asString(item.model)}`,
      category,
      providerId: asString(item.provider),
      keyLabel: asString(item.key ?? item.key_label),
      upstreamModel: asString(item.model ?? item.upstream_model),
    }))
  })
}

export function settingsFromBackend(config: Dict): Record<string, SettingValue> {
  const settings = isRecord(config.settings) ? config.settings : config
  const values: Record<string, SettingValue> = {}
  Object.entries(settings).forEach(([key, value]) => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      values[key] = value
    }
  })
  return values
}

/** 写回：保留原始 config 的未知字段与真实 Key，只更新 UI 管理的结构和设置。 */
export function applyPrototypeToBackend(original: Dict, prototype: {
  providers: Provider[]
  models: AgentModel[]
  kbCandidates: KbCandidate[]
  settings: Record<string, SettingValue>
}): Dict {
  const next: Dict = isRecord(original) ? { ...original } : {}
  const originalProviders = isRecord(original.providers) ? original.providers : {}
  const originalModels = isRecord(original.agent_models) ? original.agent_models : {}

  next.providers = Object.fromEntries(prototype.providers.map((provider) => {
    const previous = isRecord(originalProviders[provider.id]) ? (originalProviders[provider.id] as Dict) : {}
    const previousKeys = isRecord(previous.keys) ? previous.keys : {}
    const keys: Dict = {}
    provider.keys.forEach((key) => {
      // 已存在的 Key 保留真实值；新 Key 只有 masked 展示值，不能当明文写回。
      keys[key.label] = previousKeys[key.label] ?? {
        key: '',
        origin: key.source === 'vault' ? 'vault' : 'local',
        is_local: key.source !== 'vault',
      }
    })
    return [provider.id, {
      ...previous,
      name: provider.name,
      origin: provider.origin,
      base_url: provider.baseUrl,
      anthropic_base_url: provider.anthropicBaseUrl ?? previous.anthropic_base_url,
      rpm_limit: provider.rpm,
      adapter_version: provider.adapterVersion,
      protocols: provider.protocols,
      description: provider.description,
      keys,
    }]
  }))

  next.agent_models = Object.fromEntries(prototype.models.map((model) => {
    const previous = isRecord(originalModels[model.id]) ? (originalModels[model.id] as Dict) : {}
    return [model.id, {
      ...previous,
      upstream_model: model.upstreamModel ?? previous.upstream_model ?? model.id,
      active_key: model.activeKey || previous.active_key,
      keys: model.bindings.map((binding) => ({ provider: binding.providerId, key: binding.keyLabel })),
    }]
  }))

  next.candidates = Object.fromEntries(KB_CATEGORIES.map((category) => [
    category,
    prototype.kbCandidates
      .filter((candidate) => candidate.category === category)
      .map((candidate) => ({
        provider: candidate.providerId,
        key: candidate.keyLabel,
        model: candidate.upstreamModel,
      })),
  ]))

  const previousSettings = isRecord(original.settings) ? original.settings : {}
  next.settings = { ...previousSettings, ...prototype.settings }
  return next
}
