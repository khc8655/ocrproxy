import { useState, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard,
  Menu,
  RefreshCw,
  Route,
  Server,
  Settings,
  X,
} from 'lucide-react'
import type { HostKind, PageId } from '@/types'
import { Badge, Button, Segmented } from '@/components/ui/primitives'
import { APP_VERSION, APP_VERSION_SHORT } from '@/lib/constants'
import { HOST_CAPABILITIES } from '@/lib/host'
import { cn } from '@/lib/utils'

const NAV_ITEMS: { id: PageId; label: string; hint: string; icon: LucideIcon }[] = [
  { id: 'overview', label: '概览', hint: '网关与运行状态', icon: LayoutDashboard },
  { id: 'providers', label: '供应商', hint: '上游与凭证', icon: Server },
  { id: 'models', label: '模型及路由', hint: '模型与 Key 切换', icon: Route },
  { id: 'settings', label: '系统设置', hint: '策略与运维', icon: Settings },
]

const PAGE_TITLES = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.id, item.label]),
) as Record<PageId, string>

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm">
        O
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold tracking-tight text-foreground">
            OCRProxy
          </span>
          <Badge tone="neutral" className="text-[10px]">
            {APP_VERSION_SHORT}
          </Badge>
        </div>
        <p className="truncate text-[11px] text-muted-foreground">大模型中转控制台</p>
      </div>
    </div>
  )
}

function SidebarNav({
  page,
  onNavigate,
}: {
  page: PageId
  onNavigate: (next: PageId) => void
}) {
  return (
    <nav className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon
        const active = item.id === page
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            className={cn(
              'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors outline-none focus-visible:shadow-focus',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-secondary-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <Icon
              className={cn(
                'h-4 w-4 shrink-0',
                active ? 'text-primary' : 'text-muted-foreground',
              )}
            />
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  'block truncate text-sm',
                  active ? 'font-semibold' : 'font-medium',
                )}
              >
                {item.label}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {item.hint}
              </span>
            </span>
          </button>
        )
      })}
    </nav>
  )
}

function SidebarContent({
  page,
  onNavigate,
}: {
  page: PageId
  onNavigate: (next: PageId) => void
}) {
  return (
    <div className="flex h-full flex-col px-4 py-5">
      <div className="mb-6 px-1">
        <Brand />
      </div>
      <SidebarNav page={page} onNavigate={onNavigate} />
    </div>
  )
}

export function AppShell({
  page,
  onNavigate,
  modeLabel,
  hostKind,
  onHostChange,
  onRefresh,
  children,
}: {
  page: PageId
  onNavigate: (next: PageId) => void
  modeLabel: string
  hostKind: HostKind
  onHostChange: (next: HostKind) => void
  onRefresh: () => void
  children: ReactNode
}) {
  const [mobileOpen, setMobileOpen] = useState(false)

  function navigate(next: PageId) {
    onNavigate(next)
    setMobileOpen(false)
  }

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-card lg:block">
        <SidebarContent page={page} onNavigate={navigate} />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-foreground/30 backdrop-blur-[2px]"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative h-full w-64 border-r border-border bg-card shadow-xl animate-in slide-in-from-left duration-200">
            <Button
              variant="secondary"
              size="icon-sm"
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-4"
              aria-label="关闭菜单"
            >
              <X className="h-4 w-4" />
            </Button>
            <SidebarContent page={page} onNavigate={navigate} />
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 border-b border-border bg-card/85 backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center gap-3 px-4 sm:px-6 lg:px-8">
            <Button
              variant="secondary"
              size="icon-sm"
              className="lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="打开菜单"
            >
              <Menu className="h-4 w-4" />
            </Button>
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="hidden sm:inline">控制台</span>
              <span className="hidden text-border sm:inline">/</span>
              <span className="truncate text-sm font-semibold text-foreground">
                {PAGE_TITLES[page]}
              </span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="secondary"
                size="icon-sm"
                onClick={onRefresh}
                title="刷新数据"
                aria-label="刷新数据"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <div
                className="hidden sm:block"
                title="部署形态预览：正式环境由宿主自动识别"
              >
                <Segmented
                  size="sm"
                  value={hostKind}
                  onChange={onHostChange}
                  options={[
                    { label: HOST_CAPABILITIES.vm.shortLabel, value: 'vm' },
                    { label: HOST_CAPABILITIES.edgeone.shortLabel, value: 'edgeone' },
                  ]}
                />
              </div>
              <Badge tone="primary">{modeLabel}</Badge>
              <Badge tone="neutral" className="hidden font-mono sm:inline-flex">
                {APP_VERSION}
              </Badge>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6 lg:px-8 lg:py-7">
          {children}
        </main>
      </div>
    </div>
  )
}
