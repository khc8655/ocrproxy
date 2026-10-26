import { useEffect, useMemo, useState } from 'react'
import {
  initialKbCandidates,
  initialModels,
  initialProviders,
  settingGroups,
} from '@/data/mock'
import type {
  AgentModel,
  Binding,
  KbCandidate,
  ModelCategory,
  Provider,
  ProviderKey,
  Protocol,
} from '@/types'
import { DEFAULT_ADAPTER_VERSION } from '@/lib/constants'

export type SettingValue = string | number | boolean

interface Snapshot {
  version: 1
  providers: Provider[]
  models: AgentModel[]
  kbCandidates: KbCandidate[]
  settings: Record<string, SettingValue>
}

export type ImportMode = 'overwrite' | 'merge'

const STORAGE_KEY = 'ocrproxy.console.v1'
const KB_CATEGORIES: ModelCategory[] = ['chat', 'embedding', 'reranker', 'ocr']
const PROTOCOLS: Protocol[] = ['chat', 'messages', 'responses']

function defaultSettings(): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = {
    // 原型不内置任何 Key；正式接入后由登录态 + 后端配置提供。
    proxy_api_key: '',
  }
  settingGroups.forEach((group) => {
    group.fields.forEach((field) => {
      values[field.key] = field.value
    })
  })
  return values
}

function pickSettings(raw: unknown): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = {}
  if (raw && typeof raw === 'object') {
    Object.entries(raw as Record<string, unknown>).forEach(([key, value]) => {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        values[key] = value
      }
    })
  }
  if (values.run_mode === 'schedule') values.run_mode = 'agent'
  if (values.run_mode !== undefined && values.run_mode !== 'agent' && values.run_mode !== 'kb') {
    values.run_mode = 'agent'
  }
  return values
}

function normalizeSettings(raw: unknown): Record<string, SettingValue> {
  const values = { ...defaultSettings(), ...pickSettings(raw) }
  if (values.run_mode !== 'agent' && values.run_mode !== 'kb') values.run_mode = 'agent'
  return values
}

function normalizeProtocols(raw: unknown): Protocol[] {
  if (!Array.isArray(raw)) return ['chat']
  const list = raw.filter((item): item is Protocol =>
    PROTOCOLS.includes(item as Protocol),
  )
  return list.length ? list : ['chat']
}

function normalizeBindings(raw: unknown): Binding[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      providerId: String(item.providerId ?? item.provider ?? ''),
      keyLabel: String(item.keyLabel ?? item.key ?? ''),
    }))
    .filter((item) => item.providerId && item.keyLabel)
}

function normalizeProviders(raw: unknown): Provider[] | null {
  if (!Array.isArray(raw)) return null
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item): Provider => ({
      id: String(item.id ?? ''),
      name: String(item.name ?? item.id ?? ''),
      baseUrl: String(item.baseUrl ?? ''),
      anthropicBaseUrl: item.anthropicBaseUrl ? String(item.anthropicBaseUrl) : undefined,
      rpm: Number(item.rpm ?? 0) || 0,
      origin: item.origin === 'vault' ? 'vault' : 'local',
      adapterVersion: String(item.adapterVersion ?? DEFAULT_ADAPTER_VERSION),
      protocols: normalizeProtocols(item.protocols),
      description: String(item.description ?? '自定义接入的上游供应商'),
      keys: Array.isArray(item.keys)
        ? item.keys
            .filter(
              (key): key is Record<string, unknown> =>
                Boolean(key) && typeof key === 'object',
            )
            .map((key): ProviderKey => ({
              label: String(key.label ?? ''),
              masked: String(key.masked ?? ''),
              source:
                key.source === 'vault' || key.source === 'public' ? key.source : 'local',
              health:
                key.health === 'ok' ||
                key.health === 'rate_limited' ||
                key.health === 'error' ||
                key.health === 'quota'
                  ? key.health
                  : 'idle',
              latencyMs: typeof key.latencyMs === 'number' ? key.latencyMs : null,
              lastUsed: key.lastUsed ? String(key.lastUsed) : undefined,
              projectId: key.projectId ? String(key.projectId) : undefined,
              location: key.location ? String(key.location) : undefined,
            }))
            .filter((key) => key.label)
        : [],
      ruleUpdate:
        item.ruleUpdate && typeof item.ruleUpdate === 'object'
          ? {
              remoteVersion: String(
                (item.ruleUpdate as Record<string, unknown>).remoteVersion ?? '',
              ),
              updatedAt: String(
                (item.ruleUpdate as Record<string, unknown>).updatedAt ?? '',
              ),
            }
          : null,
    }))
    .filter((provider) => provider.id)
}

function normalizeModels(raw: unknown): { models: AgentModel[]; kbCandidates: KbCandidate[] } {
  const models: AgentModel[] = []
  const kbCandidates: KbCandidate[] = []
  if (!Array.isArray(raw)) return { models, kbCandidates }

  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const record = item as Record<string, unknown>
    const category = record.category
    if (category && category !== 'chat' && KB_CATEGORIES.includes(category as ModelCategory)) {
      normalizeBindings(record.bindings).forEach((binding, bindingIndex) => {
        kbCandidates.push({
          id: `kb-${String(category)}-${binding.providerId}-${binding.keyLabel}-${index}-${bindingIndex}`,
          category: category as ModelCategory,
          providerId: binding.providerId,
          keyLabel: binding.keyLabel,
          upstreamModel: String(record.upstreamModel ?? record.id ?? category),
        })
      })
      return
    }
    models.push({
      id: String(record.id ?? ''),
      upstreamModel: record.upstreamModel ? String(record.upstreamModel) : undefined,
      protocols: normalizeProtocols(record.protocols),
      category: 'chat',
      activeKey: String(record.activeKey ?? ''),
      bindings: normalizeBindings(record.bindings),
    })
  })

  return { models: models.filter((model) => model.id), kbCandidates }
}

function normalizeKbCandidates(raw: unknown): KbCandidate[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      id: String(item.id ?? ''),
      category: KB_CATEGORIES.includes(item.category as ModelCategory)
        ? (item.category as ModelCategory)
        : 'chat',
      providerId: String(item.providerId ?? ''),
      keyLabel: String(item.keyLabel ?? ''),
      upstreamModel: String(item.upstreamModel ?? ''),
    }))
    .filter((item) => item.providerId && item.keyLabel)
}

function loadSnapshot(): Snapshot | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Snapshot>
    if (parsed.version !== 1) return null
    const providers = normalizeProviders(parsed.providers)
    if (!providers) return null

    const hasKbCandidates = Array.isArray(parsed.kbCandidates)
    const split = normalizeModels(parsed.models)
    return {
      version: 1,
      providers,
      models: hasKbCandidates
        ? split.models.filter((model) => model.category === 'chat')
        : split.models,
      kbCandidates: hasKbCandidates
        ? normalizeKbCandidates(parsed.kbCandidates)
        : split.kbCandidates,
      settings: normalizeSettings(parsed.settings),
    }
  } catch {
    return null
  }
}

function persist(snapshot: Snapshot) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    /* 存储不可用时静默忽略，界面仍可正常操作 */
  }
}

function mergeByKey<T extends object>(
  current: T[],
  incoming: T[],
  key: (item: T) => string,
): T[] {
  const map = new Map(current.map((item) => [key(item), item]))
  incoming.forEach((item) => {
    map.set(key(item), map.has(key(item)) ? { ...map.get(key(item))!, ...item } : item)
  })
  return Array.from(map.values())
}

export function useConsole() {
  const snapshot = useMemo(() => loadSnapshot(), [])
  const [providers, setProviders] = useState<Provider[]>(
    () => snapshot?.providers ?? initialProviders,
  )
  const [models, setModels] = useState<AgentModel[]>(
    () => snapshot?.models ?? initialModels,
  )
  const [kbCandidates, setKbCandidates] = useState<KbCandidate[]>(
    () => snapshot?.kbCandidates ?? initialKbCandidates,
  )
  const [settingValues, setSettingValues] = useState<Record<string, SettingValue>>(
    () => snapshot?.settings ?? defaultSettings(),
  )
  const [savedSettings, setSavedSettings] = useState<Record<string, SettingValue>>(
    () => snapshot?.settings ?? defaultSettings(),
  )
  const [probing, setProbing] = useState<Set<string>>(new Set())

  useEffect(() => {
    persist({ version: 1, providers, models, kbCandidates, settings: settingValues })
  }, [providers, models, kbCandidates, settingValues])

  const dirtyKeys = useMemo(
    () => Object.keys(settingValues).filter((key) => settingValues[key] !== savedSettings[key]),
    [settingValues, savedSettings],
  )

  function updateSetting(key: string, value: SettingValue) {
    setSettingValues((current) => ({ ...current, [key]: value }))
  }

  function saveSettings() {
    setSavedSettings({ ...settingValues })
    return dirtyKeys.length
  }

  function saveVaultConfig() {
    setSavedSettings((current) => ({
      ...current,
      vault_url: settingValues.vault_url,
      vault_token: settingValues.vault_token,
    }))
  }

  function discardSettings() {
    setSettingValues({ ...savedSettings })
  }

  function resetSettings() {
    const defaults = defaultSettings()
    setSettingValues(defaults)
    setSavedSettings(defaults)
  }

  function refreshFromStorage() {
    const next = loadSnapshot()
    if (!next) return false
    setProviders(next.providers)
    setModels(next.models)
    setKbCandidates(next.kbCandidates)
    setSettingValues(next.settings)
    setSavedSettings(next.settings)
    return true
  }

  function addProvider(provider: Provider) {
    setProviders((current) => [...current, provider])
  }

  function updateProvider(next: Provider) {
    setProviders((current) =>
      current.map((provider) => (provider.id === next.id ? next : provider)),
    )
  }

  function applyProviderRuleUpdate(providerId: string) {
    setProviders((current) =>
      current.map((provider) =>
        provider.id === providerId && provider.ruleUpdate
          ? {
              ...provider,
              adapterVersion: provider.ruleUpdate.remoteVersion,
              ruleUpdate: null,
            }
          : provider,
      ),
    )
  }

  function withBindings(model: AgentModel, bindings: Binding[]): AgentModel {
    const stillValid = bindings.some(
      (binding) => `${binding.providerId}:${binding.keyLabel}` === model.activeKey,
    )
    const first = bindings[0]
    return {
      ...model,
      bindings,
      activeKey: stillValid
        ? model.activeKey
        : first
          ? `${first.providerId}:${first.keyLabel}`
          : '',
    }
  }

  function deleteProvider(providerId: string) {
    setProviders((current) => current.filter((provider) => provider.id !== providerId))
    setModels((current) =>
      current.map((model) =>
        withBindings(
          model,
          model.bindings.filter((binding) => binding.providerId !== providerId),
        ),
      ),
    )
    setKbCandidates((current) =>
      current.filter((candidate) => candidate.providerId !== providerId),
    )
  }

  function addProviderKey(providerId: string, key: ProviderKey) {
    setProviders((current) =>
      current.map((provider) =>
        provider.id === providerId
          ? { ...provider, keys: [...provider.keys, key] }
          : provider,
      ),
    )
  }

  function renameBindings(providerId: string, fromLabel: string, toLabel: string) {
    setModels((current) =>
      current.map((model) => {
        const bindings = model.bindings.map((binding) =>
          binding.providerId === providerId && binding.keyLabel === fromLabel
            ? { ...binding, keyLabel: toLabel }
            : binding,
        )
        const activeKey =
          model.activeKey === `${providerId}:${fromLabel}`
            ? `${providerId}:${toLabel}`
            : model.activeKey
        return { ...model, bindings, activeKey }
      }),
    )
    setKbCandidates((current) =>
      current.map((candidate) =>
        candidate.providerId === providerId && candidate.keyLabel === fromLabel
          ? { ...candidate, keyLabel: toLabel }
          : candidate,
      ),
    )
  }

  function updateProviderKey(providerId: string, originalLabel: string, next: ProviderKey) {
    setProviders((current) =>
      current.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              keys: provider.keys.map((key) =>
                key.label === originalLabel ? next : key,
              ),
            }
          : provider,
      ),
    )
    if (next.label !== originalLabel) {
      renameBindings(providerId, originalLabel, next.label)
    }
  }

  function deleteProviderKey(providerId: string, keyLabel: string) {
    setProviders((current) =>
      current.map((provider) =>
        provider.id === providerId
          ? { ...provider, keys: provider.keys.filter((key) => key.label !== keyLabel) }
          : provider,
      ),
    )
    setModels((current) =>
      current.map((model) =>
        withBindings(
          model,
          model.bindings.filter(
            (binding) =>
              !(binding.providerId === providerId && binding.keyLabel === keyLabel),
          ),
        ),
      ),
    )
    setKbCandidates((current) =>
      current.filter(
        (candidate) =>
          !(candidate.providerId === providerId && candidate.keyLabel === keyLabel),
      ),
    )
  }

  function addModel(model: AgentModel) {
    setModels((current) => [...current, model])
  }

  function updateModel(next: AgentModel) {
    setModels((current) =>
      current.map((model) => (model.id === next.id ? next : model)),
    )
  }

  function deleteModel(modelId: string) {
    setModels((current) => current.filter((model) => model.id !== modelId))
  }

  function setActiveBinding(modelId: string, binding: Binding) {
    setModels((current) =>
      current.map((model) =>
        model.id === modelId
          ? { ...model, activeKey: `${binding.providerId}:${binding.keyLabel}` }
          : model,
      ),
    )
  }

  function reorderBindings(modelId: string, from: number, to: number) {
    setModels((current) =>
      current.map((model) => {
        if (model.id !== modelId) return model
        if (
          from === to ||
          from < 0 ||
          to < 0 ||
          from >= model.bindings.length ||
          to >= model.bindings.length
        ) {
          return model
        }
        const bindings = [...model.bindings]
        const [moved] = bindings.splice(from, 1)
        if (!moved) return model
        bindings.splice(to, 0, moved)
        return { ...model, bindings }
      }),
    )
  }

  function removeBinding(modelId: string, binding: Binding) {
    setModels((current) =>
      current.map((model) =>
        model.id === modelId
          ? withBindings(
              model,
              model.bindings.filter(
                (item) =>
                  !(
                    item.providerId === binding.providerId &&
                    item.keyLabel === binding.keyLabel
                  ),
              ),
            )
          : model,
      ),
    )
  }

  async function probeKey(probeId: string, providerId: string, keyLabel: string) {
    setProbing((current) => new Set(current).add(probeId))
    await new Promise((resolve) => window.setTimeout(resolve, 850))
    const latency = 220 + Math.floor(Math.random() * 680)
    setProviders((current) =>
      current.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              keys: provider.keys.map((key) =>
                key.label === keyLabel
                  ? {
                      ...key,
                      health: 'ok',
                      latencyMs: latency,
                      lastUsed: '刚刚',
                    }
                  : key,
              ),
            }
          : provider,
      ),
    )
    setProbing((current) => {
      const next = new Set(current)
      next.delete(probeId)
      return next
    })
    return latency
  }

  async function probeBinding(modelId: string, binding: Binding) {
    return probeKey(
      `${modelId}:${binding.providerId}:${binding.keyLabel}`,
      binding.providerId,
      binding.keyLabel,
    )
  }

  function addKbCandidates(next: KbCandidate[]) {
    setKbCandidates((current) => {
      const keys = new Set(
        current.map(
          (candidate) =>
            `${candidate.category}:${candidate.providerId}:${candidate.keyLabel}:${candidate.upstreamModel}`,
        ),
      )
      const additions = next.filter((candidate) => {
        const key = `${candidate.category}:${candidate.providerId}:${candidate.keyLabel}:${candidate.upstreamModel}`
        if (keys.has(key)) return false
        keys.add(key)
        return true
      })
      return [...current, ...additions]
    })
  }

  function updateKbCandidate(next: KbCandidate) {
    setKbCandidates((current) =>
      current.map((candidate) => (candidate.id === next.id ? next : candidate)),
    )
  }

  function deleteKbCandidate(candidateId: string) {
    setKbCandidates((current) =>
      current.filter((candidate) => candidate.id !== candidateId),
    )
  }

  function reorderKbCandidates(category: ModelCategory, from: number, to: number) {
    setKbCandidates((current) => {
      const indices = current
        .map((candidate, index) => (candidate.category === category ? index : -1))
        .filter((index) => index >= 0)
      if (from === to || from < 0 || to < 0 || from >= indices.length || to >= indices.length) {
        return current
      }
      const subset = indices.map((index) => current[index])
      const [moved] = subset.splice(from, 1)
      if (!moved) return current
      subset.splice(to, 0, moved)
      const next = [...current]
      indices.forEach((index, position) => {
        next[index] = subset[position]
      })
      return next
    })
  }

  async function probeKbCandidate(candidate: KbCandidate) {
    return probeKey(`kb:${candidate.id}`, candidate.providerId, candidate.keyLabel)
  }

  function importConfig(payload: unknown, mode: ImportMode) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('配置文件不是有效的 JSON 对象')
    }
    const record = payload as Record<string, unknown>
    const importedProviders = normalizeProviders(record.providers)
    const split = normalizeModels(record.models)
    const importedModels = split.models
    const importedCandidates = Array.isArray(record.kbCandidates)
      ? normalizeKbCandidates(record.kbCandidates)
      : split.kbCandidates
    const importedSettings = normalizeSettings(record.settings)

    if (mode === 'overwrite') {
      setProviders(importedProviders ?? [])
      setModels(importedModels)
      setKbCandidates(importedCandidates)
      setSettingValues(importedSettings)
      setSavedSettings(importedSettings)
      return
    }

    setProviders((current) =>
      mergeByKey(current, importedProviders ?? [], (provider) => provider.id).map(
        (provider) => {
          const incoming = (importedProviders ?? []).find((item) => item.id === provider.id)
          return incoming
            ? {
                ...provider,
                ...incoming,
                keys: mergeByKey(provider.keys, incoming.keys, (key) => key.label),
              }
            : provider
        },
      ),
    )
    setModels((current) =>
      mergeByKey(current, importedModels, (model) => model.id),
    )
    setKbCandidates((current) => {
      const keys = new Set(
        current.map(
          (candidate) =>
            `${candidate.category}:${candidate.providerId}:${candidate.keyLabel}:${candidate.upstreamModel}`,
        ),
      )
      return [
        ...current,
        ...importedCandidates.filter((candidate) => {
          const key = `${candidate.category}:${candidate.providerId}:${candidate.keyLabel}:${candidate.upstreamModel}`
          if (keys.has(key)) return false
          keys.add(key)
          return true
        }),
      ]
    })
    const presentSettings = pickSettings(record.settings)
    setSettingValues((current) => ({ ...current, ...presentSettings }))
    setSavedSettings((current) => ({ ...current, ...presentSettings }))
  }

  return {
    providers,
    models,
    kbCandidates,
    settingValues,
    savedSettings,
    dirtyKeys,
    probing,
    updateSetting,
    saveSettings,
    saveVaultConfig,
    discardSettings,
    resetSettings,
    refreshFromStorage,
    addProvider,
    updateProvider,
    applyProviderRuleUpdate,
    deleteProvider,
    addProviderKey,
    updateProviderKey,
    deleteProviderKey,
    addModel,
    updateModel,
    deleteModel,
    setActiveBinding,
    removeBinding,
    reorderBindings,
    probeBinding,
    addKbCandidates,
    updateKbCandidate,
    deleteKbCandidate,
    reorderKbCandidates,
    probeKbCandidate,
    importConfig,
  }
}
