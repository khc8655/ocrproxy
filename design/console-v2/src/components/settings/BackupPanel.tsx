import { useMemo, useRef, useState } from 'react'
import { ChevronDown, Download, Upload, Wand2 } from 'lucide-react'
import { Button, Textarea } from '@/components/ui/primitives'
import { Dialog } from '@/components/ui/dialog'
import { CopyButton } from '@/components/common/CopyButton'
import { useToast } from '@/components/ui/toast-context'
import type { ImportMode } from '@/hooks/useConsole'

function summarize(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return { providers: 0, keys: 0, models: 0, candidates: 0 }
  }
  const record = payload as Record<string, unknown>
  const providerList = Array.isArray(record.providers)
    ? record.providers
    : record.providers && typeof record.providers === 'object'
      ? Object.values(record.providers)
      : []
  const keys = providerList.reduce((total, provider) => {
    if (!provider || typeof provider !== 'object') return total
    const keyMap = (provider as Record<string, unknown>).keys
    if (Array.isArray(keyMap)) return total + keyMap.length
    if (keyMap && typeof keyMap === 'object') return total + Object.keys(keyMap).length
    return total
  }, 0)
  const models = Array.isArray(record.models)
    ? record.models.length
    : Object.keys((record.agent_models as Record<string, unknown>) ?? {}).length
  const candidateSource = Array.isArray(record.kbCandidates)
    ? record.kbCandidates.length
    : Object.values((record.candidates as Record<string, unknown>) ?? {}).reduce<number>(
        (total, list) => total + (Array.isArray(list) ? list.length : 0),
        0,
      )
  return { providers: providerList.length, keys, models, candidates: candidateSource }
}

export function BackupPanel({
  rawConfig,
  onExport,
  onImport,
  onCopied,
}: {
  rawConfig: string
  onExport: () => void
  onImport: (payload: unknown, mode: ImportMode) => void
  onCopied: (message: string) => void
}) {
  const { toast } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ name: string; payload: unknown } | null>(null)
  const [mode, setMode] = useState<ImportMode>('overwrite')
  const text = draft ?? rawConfig

  const preview = useMemo(() => summarize(pending?.payload), [pending])

  function parseConfig(value: string) {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object') throw new Error('配置必须是 JSON 对象')
    return parsed
  }

  function applyRaw() {
    try {
      const payload = parseConfig(text)
      setError('')
      onImport(payload, 'overwrite')
      setDraft(null)
      toast({
        title: '底层配置已保存',
        description: '供应商、模型、知识库节点与设置已按 JSON 内容覆盖',
        variant: 'info',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'JSON 解析失败')
    }
  }

  function formatRaw() {
    try {
      setDraft(JSON.stringify(parseConfig(text), null, 2))
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'JSON 解析失败')
    }
  }

  function handleFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const payload = parseConfig(String(reader.result ?? ''))
        setPending({ name: file.name, payload })
        setMode('overwrite')
      } catch (err) {
        toast({
          title: '配置文件解析失败',
          description: err instanceof Error ? err.message : '请检查 JSON 格式',
          variant: 'error',
        })
      }
    }
    reader.readAsText(file)
  }

  return (
    <div>
      <p className="text-[11px] font-medium text-secondary-foreground">配置数据</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={onExport}>
          <Download className="h-3.5 w-3.5" />
          导出配置
        </Button>
        <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
          <Upload className="h-3.5 w-3.5" />
          导入配置
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) handleFile(file)
            event.target.value = ''
          }}
        />
      </div>

      <details className="group mt-2">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-primary [&::-webkit-details-marker]:hidden">
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
          底层配置 JSON（可直接编辑）
        </summary>
        <div className="relative mt-2">
          <Textarea
            value={text}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-[200px] resize-y bg-secondary/50 font-mono text-[11px] leading-5"
            aria-label="底层配置 JSON"
          />
          <CopyButton
            text={text}
            variant="secondary"
            onCopied={() => onCopied('已复制底层配置 JSON')}
            className="absolute right-2 top-2 h-7 w-7"
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={formatRaw}>
            <Wand2 className="h-3.5 w-3.5" />
            格式化 JSON
          </Button>
          <Button variant="primary" size="sm" onClick={applyRaw}>
            保存底层配置
          </Button>
          {error ? (
            <span className="text-[11px] text-destructive">JSON 格式错误：{error}</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              保存后按当前 JSON 覆盖供应商、模型与设置
            </span>
          )}
        </div>
      </details>

      <Dialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null)
        }}
        title="导入配置确认"
        description={pending ? `待导入文件：${pending.name}` : undefined}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!pending) return
                onImport(pending.payload, mode)
                setPending(null)
              }}
            >
              确认导入
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-secondary/40 px-3 py-2.5 text-xs">
          <span>
            供应商 <b className="tnum text-foreground">{preview.providers}</b> 个
          </span>
          <span>
            API Key <b className="tnum text-foreground">{preview.keys}</b> 个
          </span>
          <span>
            Agent 模型 <b className="tnum text-foreground">{preview.models}</b> 个
          </span>
          <span>
            知识库节点 <b className="tnum text-foreground">{preview.candidates}</b> 个
          </span>
        </div>

        <div className="mt-4 space-y-2.5">
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border px-3 py-2.5">
            <input
              type="radio"
              name="import-mode"
              checked={mode === 'overwrite'}
              onChange={() => setMode('overwrite')}
              className="mt-1 accent-[hsl(var(--primary))]"
            />
            <span>
              <span className="block text-xs font-semibold text-foreground">完全覆盖</span>
              <span className="block text-[11px] leading-5 text-muted-foreground">
                用导入文件替换当前全部供应商、模型与设置，导入前请先导出备份。
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border px-3 py-2.5">
            <input
              type="radio"
              name="import-mode"
              checked={mode === 'merge'}
              onChange={() => setMode('merge')}
              className="mt-1 accent-[hsl(var(--primary))]"
            />
            <span>
              <span className="block text-xs font-semibold text-foreground">增量合并</span>
              <span className="block text-[11px] leading-5 text-muted-foreground">
                保留现有供应商与 Key，只追加新供应商、Key、模型与知识库节点。
              </span>
            </span>
          </label>
        </div>
      </Dialog>
    </div>
  )
}
