'use client'

import type { ReactNode } from 'react'
import { AlertTriangle, Clock3, Loader2, Lock, RefreshCw, SearchX, WifiOff } from 'lucide-react'

export function LoadingState({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="state-block" aria-busy="true">
      <Loader2 size={26} className="spin" />
      <strong>{label}</strong>
    </div>
  )
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ display: 'grid', gap: 10 }} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 42 }} />
      ))}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="state-block">
      {icon ?? <SearchX size={30} />}
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-block danger" role="alert">
      <WifiOff size={28} />
      <strong>数据加载失败</strong>
      <p>{message}</p>
      {onRetry && (
        <button className="button" onClick={onRetry}>
          <RefreshCw size={14} /> 重试
        </button>
      )}
    </div>
  )
}

export function PermissionDenied({ capability }: { capability?: string }) {
  return (
    <div className="state-block permission">
      <Lock size={28} />
      <strong>没有访问权限</strong>
      <p>当前角色无权查看此页面{capability ? `（需要 ${capability} 权限）` : ''}。请联系组织管理员调整角色。</p>
    </div>
  )
}

export function StaleBadge() {
  return (
    <span className="stale-badge" title="显示的是上次成功加载的数据">
      <Clock3 size={12} /> 数据可能已过期
    </span>
  )
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <AlertTriangle size={15} /> {message}
      {onRetry && <button onClick={onRetry}>重试</button>}
    </div>
  )
}
