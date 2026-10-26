import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch {
      return false
    }
  }
}

export function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN')
}

export function formatLatency(ms?: number | null): string {
  if (ms === null || ms === undefined || ms <= 0) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${ms}ms`
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

export function maskSecret(secret: string): string {
  const clean = secret.trim()
  if (!clean) return ''
  if (clean.length <= 8) return `${clean.slice(0, 2)}••••`
  return `${clean.slice(0, 4)}${'•'.repeat(8)}${clean.slice(-4)}`
}

export function randomClientKey(): string {
  const chars = 'abcdef0123456789'
  let body = ''
  for (let i = 0; i < 28; i += 1) {
    body += chars[Math.floor(Math.random() * chars.length)]
  }
  return `sk-ocr-${body}`
}

export function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
