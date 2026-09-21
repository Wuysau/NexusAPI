'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { FileJson, FolderOpen, LoaderCircle } from 'lucide-react'
import { apiGet, apiSend, errorMessage } from '@/components/lib/api'
import styles from './workspace.module.css'
import { HelpDetails } from '@/components/HelpDetails'

export function ObserverPathField({
  value,
  onChange,
  onBusyChange,
}: {
  value: string
  onChange: (path: string) => void
  onBusyChange: (busy: boolean) => void
}) {
  const inputId = useId()
  const [capability, setCapability] = useState<{ available: boolean; reason: string | null } | null>(null)
  const [picking, setPicking] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    const check = new AbortController()
    void apiGet<{ available: boolean; reason: string | null }>('/api/local/observer-path', check.signal)
      .then(setCapability)
      .catch(() => {
        if (!check.signal.aborted) setCapability({ available: false, reason: '系统选择器暂不可用，仍可手动输入路径。' })
      })
    return () => {
      check.abort()
      controller.current?.abort()
      onBusyChange(false)
    }
  }, [onBusyChange])
  async function pick(kind: 'file' | 'directory') {
    if (picking || !capability?.available) return
    const abort = new AbortController()
    controller.current = abort
    setPicking(true)
    onBusyChange(true)
    setError('')
    setMessage('请在系统选择窗口中完成选择，或取消返回。窗口两分钟后自动关闭。')
    try {
      const result = await apiSend<{ path: string | null }>('/api/local/observer-path', 'POST', { kind }, abort.signal)
      if (abort.signal.aborted) return
      if (result.path !== null) {
        onChange(result.path)
        setMessage('已填入所选路径，可继续手动修改。')
      } else setMessage('已取消选择，原路径保持不变。')
    } catch (e) {
      if (!abort.signal.aborted) {
        setMessage('')
        setError(errorMessage(e))
      }
    } finally {
      if (!abort.signal.aborted) {
        setPicking(false)
        onBusyChange(false)
      }
      controller.current = null
    }
  }
  return (
    <div className={styles.field}>
      <label htmlFor={inputId}>本机 Codex 记录路径</label>
      <input
        id={inputId}
        required
        value={value}
        disabled={picking}
        aria-describedby={inputId + '-help'}
        onChange={(e) => onChange(e.target.value)}
        placeholder="C:/Users/你的用户名/.codex/sessions"
      />
      <div className={styles.pickerActions}>
        <button
          type="button"
          className={styles.secondary}
          disabled={!capability?.available || picking}
          onClick={() => void pick('directory')}
        >
          <FolderOpen size={15} />
          选择文件夹
        </button>
        <button
          type="button"
          className={styles.secondary}
          disabled={!capability?.available || picking}
          onClick={() => void pick('file')}
        >
          <FileJson size={15} />
          选择 JSONL 文件
        </button>
        {picking && <LoaderCircle size={15} aria-label="正在选择路径" />}
      </div>
      {capability && !capability.available && <p className={styles.hint}>{capability.reason}</p>}
      <p className={styles.hint} id={inputId + '-help'}>
        填入绝对路径。选择路径时不会读取或上传记录内容。
      </p>
      <HelpDetails label="如何选择记录路径">
        <p>仅选择使用该订阅的记录。若目录混有 API key 登录的记录，请指定对应的 rollout 文件。</p>
      </HelpDetails>
      {message && (
        <p className={styles.hint} role="status">
          {message}
        </p>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
