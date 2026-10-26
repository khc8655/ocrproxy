import { useState } from 'react'
import { Power, RotateCcw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/primitives'
import { ConfirmDialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast-context'
import { APP_VERSION } from '@/lib/constants'

export function OpsPanel() {
  const { toast } = useToast()
  const [restartOpen, setRestartOpen] = useState(false)

  return (
    <div>
      <p className="text-[11px] font-medium text-secondary-foreground">系统运维</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            toast({
              title: '已是最新版本',
              description: `当前 ${APP_VERSION} 无需更新`,
              variant: 'info',
            })
          }
        >
          <Sparkles className="h-3.5 w-3.5" />
          检查程序更新
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            toast({
              title: '已解除全部冷却',
              description: '3 个 Key 已恢复为可用状态',
              variant: 'info',
            })
          }
        >
          <RotateCcw className="h-3.5 w-3.5" />
          解除所有冷却
        </Button>
        <Button variant="danger" size="sm" onClick={() => setRestartOpen(true)}>
          <Power className="h-3.5 w-3.5" />
          平滑重启服务
        </Button>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
        当前版本 {APP_VERSION} · 重启会等待在途请求结束后执行，通常耗时 3–5 秒
      </p>

      <ConfirmDialog
        open={restartOpen}
        onOpenChange={setRestartOpen}
        title="确认平滑重启服务？"
        description="重启期间新请求会短暂排队，在途请求会等待完成，通常耗时 3–5 秒。"
        confirmLabel="确认重启"
        tone="primary"
        onConfirm={() =>
          toast({
            title: '重启指令已下发',
            description: '服务将在在途请求结束后平滑重启',
            variant: 'info',
          })
        }
      />
    </div>
  )
}
