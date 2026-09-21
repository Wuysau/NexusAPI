'use client'

import { useState, type FormEvent } from 'react'
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { WorkspaceDialog } from './workspace/Workspace'
import styles from './workspace/workspace.module.css'
import { useSession } from './SessionProvider'
import { useToast } from './Toast'
import { errorMessage } from './lib/api'

/**
 * High-risk operations require a session created within the fresh-auth window
 * (15 min). When it has expired the server answers 401 `recent authentication
 * required`; this dialog re-verifies the password, which rotates the session.
 */
export function ReauthDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const { reauth } = useSession()
  const { notify } = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const password = String(new FormData(event.currentTarget).get('password') ?? '')
    try {
      await reauth(password)
      notify('身份已重新验证')
      onSuccess()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <WorkspaceDialog title="重新验证身份" onClose={onClose} busy={busy}>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.form}>
          <p className={styles.hint}>该操作为高风险操作，需要重新验证您的密码。验证后 15 分钟内无需重复输入。</p>
          <label className={styles.field}>
            登录密码
            <input name="password" type="password" autoFocus required autoComplete="current-password" />
          </label>
          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}
          <div className={styles.notice}>
            <ShieldCheck size={17} />
            <p>验证成功后会轮换当前会话令牌，旧令牌立即失效。</p>
          </div>
        </div>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondary} onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className={styles.primary} disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />} 验证
          </button>
        </div>
      </form>
    </WorkspaceDialog>
  )
}
