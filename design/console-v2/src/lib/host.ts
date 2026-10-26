import type { HostKind } from '@/types'

export interface HostCapabilities {
  label: string
  shortLabel: string
  runModes: Array<'agent' | 'kb'>
  logs: boolean
  vaultClient: boolean
  vaultHub: boolean
  systemUpdate: boolean
  clientKeyEditable: boolean
}

export const HOST_CAPABILITIES: Record<HostKind, HostCapabilities> = {
  vm: {
    label: 'VM 自托管',
    shortLabel: 'VM',
    runModes: ['agent', 'kb'],
    logs: true,
    vaultClient: true,
    vaultHub: false,
    systemUpdate: true,
    clientKeyEditable: true,
  },
  edgeone: {
    label: 'EdgeOne 边缘版',
    shortLabel: 'EdgeOne',
    runModes: ['agent'],
    logs: false,
    vaultClient: false,
    vaultHub: true,
    systemUpdate: false,
    clientKeyEditable: false,
  },
}

const STORAGE_KEY = 'ocrproxy.host.v1'

/** 正式部署时由宿主注入；预览环境允许手动切换两种形态核对差异。 */
export function detectHostKind(): HostKind {
  const injected = (window as Window & { __HOST_KIND__?: string }).__HOST_KIND__
  if (injected === 'edgeone' || injected === 'vm') return injected
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved === 'edgeone' || saved === 'vm') return saved
  } catch {
    /* 存储不可用时使用默认形态 */
  }
  return 'vm'
}

export function persistHostKind(kind: HostKind) {
  try {
    window.localStorage.setItem(STORAGE_KEY, kind)
  } catch {
    /* 存储不可用时静默忽略 */
  }
}
