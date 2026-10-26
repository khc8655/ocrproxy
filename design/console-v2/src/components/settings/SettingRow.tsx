import { useState, type ReactNode } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import type { SettingField } from '@/types'
import { Input, Select, Switch } from '@/components/ui/primitives'
import type { SettingValue } from '@/hooks/useConsole'
import { cn } from '@/lib/utils'

export function SettingRow({
  field,
  value,
  onChange,
  fullWidth = false,
}: {
  field: SettingField
  value: SettingValue
  onChange: (next: SettingValue) => void
  fullWidth?: boolean
}) {
  const [revealed, setRevealed] = useState(false)
  const id = `setting-${field.key}`
  const wideControl = fullWidth || field.type === 'text' || field.type === 'password'

  let control: ReactNode

  if (field.type === 'switch') {
    control = (
      <Switch
        checked={Boolean(value)}
        onCheckedChange={(next) => onChange(next)}
        ariaLabel={field.label}
      />
    )
  } else if (field.type === 'select') {
    control = (
      <Select
        id={id}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-[210px] max-w-full text-xs"
      >
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    )
  } else if (field.type === 'number') {
    control = (
      <div className="relative w-[160px] max-w-full">
        <Input
          id={id}
          type="number"
          value={String(value)}
          min={field.min}
          max={field.max}
          onWheel={(event) => event.currentTarget.blur()}
          onChange={(event) =>
            onChange(event.target.value === '' ? 0 : Number(event.target.value))
          }
          className={cn('tnum h-8 pr-10 text-right text-xs', field.mono && 'font-mono')}
        />
        {field.unit ? (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
            {field.unit}
          </span>
        ) : null}
      </div>
    )
  } else if (field.type === 'time') {
    control = (
      <Input
        id={id}
        type="time"
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
        className="tnum h-8 w-[130px] text-xs"
      />
    )
  } else if (field.type === 'password') {
    control = (
      <div className="relative w-full sm:w-[360px]">
        <Input
          id={id}
          type={revealed ? 'text' : 'password'}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 pr-8 font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => setRevealed((current) => !current)}
          className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label={revealed ? '隐藏内容' : '显示内容'}
        >
          {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
    )
  } else {
    control = (
      <Input
        id={id}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-8 text-xs',
          wideControl ? 'w-full sm:w-[360px]' : 'w-[210px]',
          field.mono && 'font-mono',
        )}
      />
    )
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6',
        fullWidth && 'sm:col-span-2',
      )}
    >
      <div className="min-w-0">
        <label htmlFor={id} className="text-xs font-medium leading-5 text-foreground">
          {field.label}
        </label>
        {field.hint ? (
          <p className="text-[10px] leading-4 text-muted-foreground">{field.hint}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-start sm:justify-end">{control}</div>
    </div>
  )
}
