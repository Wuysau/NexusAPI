'use client'

import { useEffect, useRef, useState } from 'react'
import { apiSend, errorMessage } from '@/components/lib/api'
import { useHighRiskAction } from '@/components/lib/useHighRiskAction'
import { ReauthDialog } from '@/components/ReauthDialog'
import { WorkspaceDialog, WorkspaceNotice } from '@/components/workspace/Workspace'
import styles from '@/components/workspace/workspace.module.css'

export function ConnectionRevokeDialog({
  connectionId,
  label,
  onClose,
  onRevoked,
}: {
  connectionId: string
  label: string
  onClose: () => void
  onRevoked: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scope = useRef<AbortController | null>(null)
  const highRisk = useHighRiskAction()
  const clearPending = highRisk.clear
  const blocked = busy || highRisk.busy || highRisk.needsReauth
  const dialogLifetime = scope.current

  useEffect(() => {
    const lifetime = new AbortController()
    scope.current = lifetime
    return () => {
      lifetime.abort()
      clearPending()
      if (scope.current === lifetime) scope.current = null
    }
  }, [connectionId, clearPending])

  function close() {
    scope.current?.abort()
    clearPending()
    onClose()
  }

  async function revoke() {
    const lifetime = scope.current
    if (!lifetime || lifetime.signal.aborted || blocked) return
    const current = () => !lifetime.signal.aborted && scope.current === lifetime
    setError('')
    try {
      await highRisk.run(async () => {
        if (!current()) return
        setBusy(true)
        try {
          await apiSend('/api/connections/' + encodeURIComponent(connectionId), 'DELETE', undefined, lifetime.signal)
          if (current()) onRevoked()
        } catch (e) {
          // A removed confirmation must not queue or resume its old action.
          if (current()) throw e
        } finally {
          if (current()) setBusy(false)
        }
      })
    } catch (e) {
      if (current()) setError(errorMessage(e))
    }
  }

  async function retry(lifetime: AbortController | null) {
    if (!lifetime || lifetime.signal.aborted || scope.current !== lifetime) return
    try {
      await highRisk.retry()
    } catch (e) {
      if (!lifetime.signal.aborted && scope.current === lifetime) setError(errorMessage(e))
    }
  }

  return (
    <WorkspaceDialog title="撤销连接" busy={busy || highRisk.busy} onClose={close}>
      <div className={styles.form}>
        <p className={styles.description}>
          撤销「{label}」后，此映射不能继续关联新的观测记录，连接器租约也会撤销。历史用量保留；重新接入需创建新连接。
        </p>
        {error && <WorkspaceNotice error>{error}</WorkspaceNotice>}
        <div className={styles.dialogActions}>
          <button className={styles.secondary} disabled={busy || highRisk.busy} onClick={close}>
            取消
          </button>
          <button className={styles.danger} disabled={blocked} onClick={() => void revoke()}>
            {busy || highRisk.busy ? '撤销中…' : '确认撤销'}
          </button>
        </div>
      </div>
      {highRisk.needsReauth && (
        <ReauthDialog
          onClose={() => {
            if (dialogLifetime && !dialogLifetime.signal.aborted && scope.current === dialogLifetime) clearPending()
          }}
          onSuccess={() => void retry(dialogLifetime)}
        />
      )}
    </WorkspaceDialog>
  )
}
