/**
 * 真实后端 API 适配层（第二阶段脚手架）。
 *
 * 当前原型页面尚未全部改为调用这里；本文件先把现有后台契约固化下来，
 * 供后续 useConsole / 页面逐项替换，避免再出现“UI 写 A、后端读 B”。
 */
import { detectHostKind } from '@/lib/host'
import type { HostKind } from '@/types'

const TOKEN_KEY = 'ocrproxy.admin.token'
const HOST = () => detectHostKind()

export class ApiError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function getAdminToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setAdminToken(token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token)
    // 旧控制台只把管理员密码放 sessionStorage；这里同样禁止长期 localStorage。
    window.localStorage.removeItem('ocrproxy.admin.token')
  } catch {
    /* ignore */
  }
}

export function clearAdminToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

function configPath(kind: HostKind): string {
  return kind === 'edgeone' ? '/api/config' : '/api/admin/config'
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  token = getAdminToken(),
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  if (response.status === 401) {
    clearAdminToken()
    throw new ApiError(401, '管理员凭证无效或已过期', 'unauthorized')
  }

  let body: unknown = null
  const text = await response.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!response.ok) {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
    const error = record?.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : null
    const message = String(error?.message ?? record?.detail ?? `HTTP ${response.status}`)
    throw new ApiError(response.status, message, String(error?.code ?? response.status))
  }
  return body as T
}

/** 登录校验：现有后台以“带管理员密码 GET 配置”作为登录校验，不新造接口。 */
export async function loginAdmin(password: string): Promise<boolean> {
  const token = password.trim()
  if (!token) return false
  try {
    await request<unknown>(configPath(HOST()), {}, token)
    setAdminToken(token)
    return true
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return false
    throw error
  }
}

export function logoutAdmin(): void {
  clearAdminToken()
}

export function isAuthenticated(): boolean {
  return Boolean(getAdminToken())
}

export interface BackendConfigEnvelope {
  config: Record<string, unknown>
  version?: number
}

/** GET 配置。VM 返回 {config,...}；EdgeOne 可能直接返回 config，做兼容。 */
export async function fetchBackendConfig(): Promise<BackendConfigEnvelope> {
  const kind = HOST()
  const raw = await request<Record<string, unknown>>(configPath(kind))
  const config = raw.config && typeof raw.config === 'object'
    ? (raw.config as Record<string, unknown>)
    : raw
  const versionRaw = raw._version ?? config._version
  return {
    config,
    version: typeof versionRaw === 'number' ? versionRaw : undefined,
  }
}

/** 保存配置：VM 用 POST /api/admin/config；EdgeOne 用 PUT /api/config。 */
export async function saveBackendConfig(
  config: Record<string, unknown>,
  version?: number,
): Promise<BackendConfigEnvelope> {
  const kind = HOST()
  const body = { ...config, ...(version === undefined ? {} : { _version: version }) }
  const raw = await request<Record<string, unknown>>(configPath(kind), {
    method: kind === 'edgeone' ? 'PUT' : 'POST',
    body: JSON.stringify(body),
  })
  const next = raw.config && typeof raw.config === 'object'
    ? (raw.config as Record<string, unknown>)
    : raw
  const nextVersion = raw._version ?? next._version
  return { config: next, version: typeof nextVersion === 'number' ? nextVersion : undefined }
}

export async function fetchBackendStats(): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>('/api/admin/stats')
}

export interface ProbeResult {
  ok: boolean
  status?: number
  latencyMs?: number
  mode?: string
  error?: string
}

export async function probeProviderKey(
  provider: string,
  key: string,
  model = '',
  agentModel = '',
): Promise<ProbeResult> {
  const kind = HOST()
  const path = kind === 'edgeone' ? '/api/test' : '/api/admin/test-candidate'
  const body = kind === 'edgeone'
    ? { provider, key, model, agent_model: agentModel }
    : { type: 'agent', category: 'agent', provider, key, model_name: model, agent_model: agentModel }
  const raw = await request<Record<string, unknown>>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return {
    ok: raw.ok === true || raw.success === true,
    status: typeof raw.status === 'number' ? raw.status : undefined,
    latencyMs: typeof raw.latency_ms === 'number' ? raw.latency_ms : undefined,
    mode: typeof raw.mode === 'string' ? raw.mode : undefined,
    error: raw.error ? String(raw.error).slice(0, 300) : undefined,
  }
}
