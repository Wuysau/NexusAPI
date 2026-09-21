'use client'
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { RefreshCw, Check } from 'lucide-react'
import { HelpDetails } from '@/components/HelpDetails'
import { apiGet, apiSend, errorMessage } from '@/components/lib/api'
import type { ObserverResult, ObserverState } from '@/lib/observer/service'
import { localDate, WorkspaceNotice } from './Workspace'
import styles from './workspace.module.css'

interface ObserverView {
  available: boolean
  reason?: string
  configured?: boolean
  enabled?: boolean
  intervalSeconds?: number
  state?: ObserverState
  source?: string
  runtime?: {
    last_sync_started_at: string | null
    last_sync_completed_at: string | null
    last_successful_sync_at: string | null
    next_sync_at: string | null
    last_error: string | null
    requested_at: string | null
    last_result: Partial<ObserverResult>
  } | null
}
const states: Record<ObserverState, string> = {
  running: '运行中',
  syncing: '同步中',
  idle: '等待下次同步',
  not_configured: '尚未配置',
  source_unavailable: '记录目录不可用',
  error: '同步异常',
  stopped: '后台已停止',
}
const errors: Record<string, string> = {
  source_unavailable: '无法访问 Codex 记录目录，请检查路径与目录权限。',
  invalid_configuration: 'Observer 配置无效，请检查本机配置文件。',
  sync_failed: '本轮同步失败，请检查数据库与连接映射；后台会在下一轮重试。',
}
const count = (value: number) => value.toLocaleString()
export function ObserverPanel({
  connectionId,
  source,
  setSource,
  disabled,
  onSynced,
}: {
  connectionId: string
  source: string
  setSource: Dispatch<SetStateAction<string>>
  disabled: boolean
  onSynced: () => void
}) {
  const [data, setData] = useState<ObserverView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const completed = useRef<string | null>(null)
  const callback = useRef(onSynced)
  useEffect(() => {
    callback.current = onSynced
  }, [onSynced])
  const endpoint = '/api/local/observer?connectionId=' + encodeURIComponent(connectionId)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const next = await apiGet<ObserverView>(endpoint, controller.signal)
        if (controller.signal.aborted) return
        setData(next)
        if (next.source) setSource((current) => current || next.source!)
        const time = next.runtime?.last_sync_completed_at ?? null
        if (time && time !== completed.current) {
          callback.current()
          if (completed.current) setNotice(next.runtime?.last_error ? '' : '同步完成，项目统计已更新。')
        }
        completed.current = time
      } catch (e) {
        if (!controller.signal.aborted) setError(errorMessage(e))
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 3000)
      }
    }
    void refresh()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [endpoint, setSource])
  async function act(action: 'apply' | 'sync') {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await apiSend<{ result: string }>('/api/local/observer', 'POST', {
        action,
        connectionId,
        ...(action === 'apply' ? { source: source.trim() } : {}),
      })
      setNotice(
        action === 'apply'
          ? '配置已应用，后台会自动加载。'
          : result.result === 'already_syncing'
            ? '已有同步任务正在处理。'
            : '已请求同步，正在等待后台结果…',
      )
      setData(await apiGet<ObserverView>(endpoint))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const status = data?.state ?? 'not_configured'
  const runtime = data?.runtime
  const result = runtime?.last_result
  return (
    <section className={styles.accountSection} aria-label="Codex Observer">
      <div className={styles.accountHeading}>
        <div>
          <h3>本机用量同步</h3>
        </div>
        <button
          type="button"
          className={styles.secondary}
          disabled={
            busy ||
            !data?.available ||
            !data.configured ||
            status === 'stopped' ||
            status === 'syncing' ||
            Boolean(runtime?.requested_at)
          }
          onClick={() => void act('sync')}
        >
          <RefreshCw size={14} />
          {status === 'syncing' || runtime?.requested_at ? '同步中…' : '立即同步'}
        </button>
      </div>
      {error && <WorkspaceNotice error>{error}</WorkspaceNotice>}
      {notice && <WorkspaceNotice>{notice}</WorkspaceNotice>}
      {data?.available && data.reason && <WorkspaceNotice error>{data.reason}</WorkspaceNotice>}
      {!data ? (
        <p className={styles.hint}>正在读取同步状态…</p>
      ) : !data.available ? (
        <WorkspaceNotice>{data.reason}</WorkspaceNotice>
      ) : (
        <>
          <span className={['idle', 'running', 'syncing'].includes(status) ? styles.badge : styles.mutedBadge}>
            {states[status]}
          </span>
          <dl className={styles.details}>
            <dt>自动同步</dt>
            <dd>
              {data.enabled ? '已启用' : '已关闭'} · 每 {data.intervalSeconds} 秒
            </dd>
            <dt>上次同步</dt>
            <dd>{localDate(runtime?.last_sync_completed_at ?? null)}</dd>
            <dt>下次同步</dt>
            <dd>{localDate(runtime?.next_sync_at ?? null)}</dd>
            <dt>上次成功结果</dt>
            <dd>
              {result?.newEvents == null
                ? '尚无同步结果'
                : `${count(result.newEvents)} 条新用量 · ${count(result.newSessions ?? 0)} 个新会话`}
            </dd>
          </dl>
          <HelpDetails label="同步详情">
            <dl className={styles.details}>
              <dt>最近成功</dt>
              <dd>{localDate(runtime?.last_successful_sync_at ?? null)}</dd>
              {result?.scannedFiles != null && (
                <>
                  <dt>扫描结果</dt>
                  <dd>
                    {count(result.scannedFiles)} 个文件 · {count(result.skippedDuplicates ?? 0)} 条重复 ·{' '}
                    {count(result.unassignedEvents ?? 0)} 条未归属 · {((result.durationMs ?? 0) / 1000).toFixed(1)} 秒
                  </dd>
                </>
              )}
            </dl>
          </HelpDetails>
          {runtime?.last_error && (
            <WorkspaceNotice error>{errors[runtime.last_error] ?? errors.sync_failed}</WorkspaceNotice>
          )}
          {status === 'not_configured' && <p className={styles.hint}>确认下方记录路径后应用配置，即可自动同步。</p>}
          {status === 'stopped' && (
            <p className={styles.hint}>后台尚未启动或心跳已过期。请使用本机启动入口重新启动 NexusAPI。</p>
          )}
          <button
            type="button"
            className={styles.primary}
            disabled={busy || disabled}
            onClick={() => void act('apply')}
          >
            <Check size={14} />
            {data.configured ? '应用配置更改' : '应用同步配置'}
          </button>
        </>
      )}
    </section>
  )
}
