'use client'

import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { providers as PROVIDER_DISPLAY } from '@/lib/catalog/display'

export function ProviderMark({ code, small = false }: { code?: string | null; small?: boolean }) {
  const p = PROVIDER_DISPLAY.find((x) => x.id === code) ?? { color: '#7b8794', mark: '?' }
  return (
    <span className={'provider-mark ' + (small ? 'small' : '')} style={{ color: p.color, background: p.color + '13' }}>
      {p.mark}
    </span>
  )
}

export function providerName(code?: string | null): string {
  return PROVIDER_DISPLAY.find((p) => p.id === code)?.name ?? code ?? '未知供应商'
}

export function Status({ ok = true, children }: { ok?: boolean; children?: ReactNode }) {
  return (
    <span className={'status ' + (ok ? 'good' : 'warn')}>
      <i />
      {children ?? (ok ? '正常' : '异常')}
    </span>
  )
}

export type BadgeTone = 'good' | 'warn' | 'danger' | 'info' | 'muted'

export function Badge({ tone = 'muted', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={'badge ' + (tone === 'muted' ? '' : tone)}>{children}</span>
}

const REQUEST_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  completed: { label: '成功', tone: 'good' },
  reconciled: { label: '已对账', tone: 'good' },
  failed: { label: '失败', tone: 'danger' },
  unknown: { label: '待对账', tone: 'warn' },
  created: { label: '已创建', tone: 'info' },
  reserved: { label: '已预占', tone: 'info' },
  sent: { label: '已发送', tone: 'info' },
  streaming: { label: '流式中', tone: 'info' },
}

export function RequestStatusBadge({ status }: { status: string }) {
  const meta = REQUEST_STATUS[status] ?? { label: status, tone: 'muted' as BadgeTone }
  return <Badge tone={meta.tone}>{meta.label}</Badge>
}

export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={async (event) => {
        event.stopPropagation()
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          /* clipboard unavailable — the value is still selectable in the DOM */
        }
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

/** Format a decimal money string without falling back to float arithmetic. */
export function money(value: string | number | null | undefined, digits = 4, currency: string | null = 'USD'): string {
  if (value == null || !currency) return '未知'
  const raw = String(value)
  if (!/^-?\d+(\.\d+)?$/.test(raw) || !Number.isInteger(digits) || digits < 0 || digits > 12) return '未知'
  const negative = raw.startsWith('-')
  const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.')
  const scale = 10n ** BigInt(digits)
  const rounded =
    BigInt(whole) * scale +
    BigInt((fraction + '0'.repeat(digits)).slice(0, digits) || '0') +
    (Number(fraction[digits] ?? 0) >= 5 ? 1n : 0n)
  const amount = `${negative && rounded !== 0n ? '-' : ''}${rounded / scale}${digits ? '.' + (rounded % scale).toString().padStart(digits, '0') : ''}`
  return (currency === 'USD' ? '$' : `${currency} `) + amount
}

export function num(value: string | number | null | undefined): string {
  if (value == null || value === '') return '未知'
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value).toLocaleString('en-US')
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '未知'
}

export function shortDate(value?: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function fullDate(value?: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN')
}
