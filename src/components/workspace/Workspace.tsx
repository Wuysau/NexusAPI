'use client'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { X, Search, RefreshCw } from 'lucide-react'
import { apiGet, errorMessage } from '@/components/lib/api'
import styles from './workspace.module.css'
export interface WorkspaceProject {
  id: string
  name: string
  status: string
  policyVersion: number
  memberCount: number
  connectionCount: number
  workspaceRoots: string[]
  observedSessions: string
  observedEvents: string
  lastObservedAt: string | null
}
export interface WorkspaceConnection {
  accountStatus?: string | null
  accountPlan?: string | null
  id: string
  provider: string
  mode: string
  status: string
  project_id: string | null
  project_name: string | null
  provider_identifier: string | null
  subscription_product: string | null
  revoked_at: string | null
  last_heartbeat_at: string | null
  observedSessions: string
  observedEvents: string
  lastObservedAt: string | null
}
export function useCollection<T>(path: string, key: string) {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setItems((await apiGet<Record<string, T[]>>(path))[key])
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [path, key])
  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0)
    return () => window.clearTimeout(timer)
  }, [reload])
  return { items, loading, error, reload }
}
export function WorkspaceDialog({
  title,
  children,
  busy = false,
  onClose,
}: {
  title: string
  children: ReactNode
  busy?: boolean
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => {
      dialog?.close()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onClose()
      }}
    >
      <div className={styles.dialogHeader}>
        <h2 id={titleId}>{title}</h2>
        <button type="button" className={styles.iconButton} aria-label="关闭" disabled={busy} onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  )
}
export function WorkspaceToolbar({
  search,
  setSearch,
  label,
  loading,
  reload,
  children,
}: {
  search: string
  setSearch: (value: string) => void
  label: string
  loading: boolean
  reload: () => Promise<void>
  children?: ReactNode
}) {
  return (
    <div className={styles.toolbar}>
      <label className={styles.search}>
        <Search size={16} />
        <input aria-label={label} placeholder={label} value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <div className={styles.toolbarActions}>
        {children}
        <button type="button" className={styles.secondary} disabled={loading} onClick={() => void reload()}>
          <RefreshCw size={14} />
          刷新
        </button>
      </div>
    </div>
  )
}
export function WorkspaceNotice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={error ? styles.error : styles.notice} role={error ? 'alert' : 'status'}>
      {children}
    </div>
  )
}
export function localDate(value: string | null) {
  return value
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '尚无记录'
}
export function count(value: string) {
  return BigInt(value).toLocaleString('zh-CN')
}
