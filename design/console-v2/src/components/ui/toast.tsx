import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ToastContext,
  type ToastApi,
  type ToastVariant,
} from '@/components/ui/toast-context'

interface ToastItem {
  id: number
  title: string
  description?: string
  variant: ToastVariant
}

const variantStyles: Record<ToastVariant, string> = {
  success: 'border-success/25 text-success',
  error: 'border-destructive/25 text-destructive',
  info: 'border-info/25 text-info',
}

const variantIcons: Record<ToastVariant, ReactNode> = {
  success: <CircleCheck className="h-4 w-4" />,
  error: <TriangleAlert className="h-4 w-4" />,
  info: <Info className="h-4 w-4" />,
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const counter = useRef(0)
  const timers = useRef<number[]>([])

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  const toast = useCallback<ToastApi['toast']>(
    ({ title, description, variant = 'success' }) => {
      counter.current += 1
      const id = counter.current
      setItems((current) => [...current.slice(-3), { id, title, description, variant }])
      const timer = window.setTimeout(() => dismiss(id), 3200)
      timers.current.push(timer)
    },
    [dismiss],
  )

  useEffect(() => {
    const scheduled = timers.current
    return () => {
      scheduled.forEach((timer) => window.clearTimeout(timer))
    }
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[min(22rem,calc(100vw-2.5rem))] flex-col gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="pointer-events-auto flex items-start gap-3 rounded-2xl border border-border bg-card p-3.5 shadow-lg animate-in slide-in-from-bottom-2 fade-in-0 duration-200"
          >
            <span
              className={cn(
                'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border bg-card',
                variantStyles[item.variant],
              )}
            >
              {variantIcons[item.variant]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-foreground">{item.title}</p>
              {item.description ? (
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {item.description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label="关闭提示"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
