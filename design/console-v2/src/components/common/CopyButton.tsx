import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button, type ButtonProps } from '@/components/ui/primitives'
import { copyText } from '@/lib/utils'

export function CopyButton({
  text,
  label,
  children,
  onCopied,
  size = 'icon-sm',
  variant = 'ghost',
  className,
}: {
  text: string
  label?: string
  children?: ReactNode
  onCopied?: () => void
  size?: ButtonProps['size']
  variant?: ButtonProps['variant']
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    const ok = await copyText(text)
    if (!ok) return
    setCopied(true)
    onCopied?.()
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={handleCopy}
      title="复制"
      aria-label="复制"
      className={className}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {children ?? (label ? <span>{label}</span> : null)}
    </Button>
  )
}
