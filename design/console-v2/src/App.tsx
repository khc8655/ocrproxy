import { useMemo, useState } from 'react'
import type { HostKind, PageId } from '@/types'
import { overviewStats } from '@/data/mock'
import { useConsole, type ImportMode } from '@/hooks/useConsole'
import { APP_VERSION, GATEWAY_BASE_URL } from '@/lib/constants'
import { HOST_CAPABILITIES, detectHostKind, persistHostKind } from '@/lib/host'
import { downloadJson } from '@/lib/utils'
import { ToastProvider } from '@/components/ui/toast'
import { useToast } from '@/components/ui/toast-context'
import { AppShell } from '@/components/layout/AppShell'
import { OverviewPage } from '@/components/dashboard/OverviewPage'
import { ProvidersPage } from '@/components/providers/ProvidersPage'
import { ModelsPage } from '@/components/models/ModelsPage'
import { SettingsPage } from '@/components/settings/SettingsPage'

function ConsoleWorkspace() {
  const consoleState = useConsole()
  const { toast } = useToast()
  const [page, setPage] = useState<PageId>('overview')
  const [hostKind, setHostKind] = useState<HostKind>(() => detectHostKind())
  const capabilities = HOST_CAPABILITIES[hostKind]

  const exportConfig = useMemo(
    () => ({
      version: APP_VERSION,
      providers: consoleState.providers,
      models: consoleState.models,
      kbCandidates: consoleState.kbCandidates,
      settings: consoleState.savedSettings,
    }),
    [
      consoleState.providers,
      consoleState.models,
      consoleState.kbCandidates,
      consoleState.savedSettings,
    ],
  )

  const rawConfig = useMemo(() => JSON.stringify(exportConfig, null, 2), [exportConfig])
  const savedRunMode = String(consoleState.savedSettings.run_mode ?? 'agent')
  const runMode = capabilities.runModes.includes(savedRunMode as 'agent' | 'kb')
    ? (savedRunMode as 'agent' | 'kb')
    : 'agent'
  const modeLabel =
    hostKind === 'edgeone'
      ? 'EdgeOne 边缘版 · Agent'
      : runMode === 'kb'
        ? '知识库模式'
        : 'Agent 模式'
  const clientKey = String(consoleState.savedSettings.proxy_api_key ?? '')
  const agentRouting = String(
    consoleState.savedSettings.agent_routing_strategy ?? 'sticky_failover',
  )
  const kbRouting = String(
    consoleState.savedSettings.kb_routing_strategy ?? 'round_robin',
  )

  function handleCopied(message: string) {
    toast({ title: message })
  }

  function handleHostChange(next: HostKind) {
    setHostKind(next)
    persistHostKind(next)
    toast({
      title: `已切换到${HOST_CAPABILITIES[next].label}`,
      description:
        next === 'edgeone'
          ? 'EdgeOne 固定 Agent 模式，客户端 Key 由环境变量注入'
          : 'VM 支持 Agent / 知识库双模式与本地运维面板',
      variant: 'info',
    })
  }

  function handleRefresh() {
    const restored = consoleState.refreshFromStorage()
    toast({
      title: restored ? '数据已刷新' : '暂无本地快照',
      description: restored
        ? '已重新读取本地保存的供应商、模型、知识库节点与设置'
        : '当前使用种子数据，修改后会自动写入本地快照',
      variant: 'info',
    })
  }

  function handleExport() {
    downloadJson('ocrproxy-config-2026-10-26.json', exportConfig)
    toast({
      title: '配置已导出',
      description: '供应商、Key、Agent 模型、知识库节点与设置已下载为 JSON',
      variant: 'info',
    })
  }

  function handleImport(payload: unknown, mode: ImportMode) {
    consoleState.importConfig(payload, mode)
    toast({
      title: mode === 'overwrite' ? '配置已覆盖导入' : '配置已增量合并',
      description: '列表与设置已按导入结果更新',
      variant: 'info',
    })
  }

  return (
    <AppShell
      page={page}
      onNavigate={setPage}
      modeLabel={modeLabel}
      hostKind={hostKind}
      onHostChange={handleHostChange}
      onRefresh={handleRefresh}
    >
      {page === 'overview' ? (
        <OverviewPage
          stats={overviewStats}
          gatewayBaseUrl={GATEWAY_BASE_URL}
          clientKey={clientKey}
          models={consoleState.models}
          kbCandidates={consoleState.kbCandidates}
          providers={consoleState.providers}
          runMode={runMode}
          hostKind={hostKind}
          onCopied={handleCopied}
        />
      ) : null}

      {page === 'providers' ? (
        <ProvidersPage
          providers={consoleState.providers}
          hostKind={hostKind}
          onAddProvider={consoleState.addProvider}
          onUpdateProvider={consoleState.updateProvider}
          onDeleteProvider={consoleState.deleteProvider}
          onAddKey={consoleState.addProviderKey}
          onUpdateKey={consoleState.updateProviderKey}
          onDeleteKey={consoleState.deleteProviderKey}
          onApplyRuleUpdate={consoleState.applyProviderRuleUpdate}
        />
      ) : null}

      {page === 'models' ? (
        <ModelsPage
          models={consoleState.models}
          kbCandidates={consoleState.kbCandidates}
          providers={consoleState.providers}
          probing={consoleState.probing}
          hostKind={hostKind}
          runMode={runMode}
          agentRouting={agentRouting}
          kbRouting={kbRouting}
          onAddModel={consoleState.addModel}
          onUpdateModel={consoleState.updateModel}
          onDeleteModel={consoleState.deleteModel}
          onSetActive={consoleState.setActiveBinding}
          onRemoveBinding={consoleState.removeBinding}
          onReorderBindings={consoleState.reorderBindings}
          onProbe={consoleState.probeBinding}
          onAddKbCandidates={consoleState.addKbCandidates}
          onUpdateKbCandidate={consoleState.updateKbCandidate}
          onDeleteKbCandidate={consoleState.deleteKbCandidate}
          onReorderKbCandidates={consoleState.reorderKbCandidates}
          onProbeKbCandidate={consoleState.probeKbCandidate}
        />
      ) : null}

      {page === 'settings' ? (
        <SettingsPage
          values={consoleState.settingValues}
          dirtyKeys={consoleState.dirtyKeys}
          hostKind={hostKind}
          runMode={runMode}
          onChange={consoleState.updateSetting}
          onSave={consoleState.saveSettings}
          onDiscard={consoleState.discardSettings}
          onReset={consoleState.resetSettings}
          onExport={handleExport}
          onImport={handleImport}
          onSaveVault={consoleState.saveVaultConfig}
          rawConfig={rawConfig}
          onCopied={handleCopied}
        />
      ) : null}
    </AppShell>
  )
}

export function App() {
  return (
    <ToastProvider>
      <ConsoleWorkspace />
    </ToastProvider>
  )
}
