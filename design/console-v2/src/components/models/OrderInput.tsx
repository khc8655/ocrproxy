import { useState } from 'react'
import { cn } from '@/lib/utils'

export function OrderInput({
  index,
  total,
  active = false,
  label = 'Key',
  onCommit,
}: {
  index: number
  total: number
  active?: boolean
  label?: string
  onCommit: (next: number) => void
}) {
  const [value, setValue] = useState(String(index + 1))
  const numeric = Number(value)
  const invalid = value !== '' && (numeric < 1 || numeric > total)

  function commit() {
    const next = Number(value)
    if (!Number.isInteger(next) || next < 1 || next > total) {
      setValue(String(index + 1))
      return
    }
    if (next === index + 1) {
      setValue(String(next))
      return
    }
    onCommit(next - 1)
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      maxLength={String(total).length}
      value={value}
      disabled={total < 2}
      onChange={(event) => setValue(event.target.value.replace(/\D/g, ''))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        }
      }}
      className={cn(
        'tnum h-7 w-11 rounded-lg border border-border bg-card text-center text-[11px] font-semibold text-foreground outline-none transition-shadow focus-visible:border-primary focus-visible:shadow-focus disabled:cursor-default disabled:bg-secondary disabled:text-muted-foreground',
        active && 'border-primary/30 bg-primary/5 text-primary',
        invalid && 'border-destructive/40 text-destructive focus-visible:border-destructive',
      )}
      aria-label={`第 ${index + 1} 个${label}的顺序，共 ${total} 个`}
      title={`输入 1–${total} 调整顺序，回车或离开输入框生效`}
    />
  )
}
