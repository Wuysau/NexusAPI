'use client'
import { useEffect, useState } from 'react'
import { apiGet, apiSend, errorMessage } from '@/components/lib/api'
import type { CollectorObservation } from '@/lib/subscriptions/collector'
import { collectorProviders } from '@/lib/subscriptions/collector-providers'
import styles from '@/components/workspace/workspace.module.css'

type View = { observation: CollectorObservation | null; configured: boolean; canManage: boolean; canRefresh: boolean }
const labels = { reported: '采集器已上报', stale: '数据已过期', unknown: '额度未知', error: '采集失败' }
export default function SubscriptionMonitor({
  connectionId,
  providerType,
  canManage = true,
}: {
  connectionId: string
  providerType: string
  canManage?: boolean
}) {
  const providers = collectorProviders(providerType)
  const [provider, setProvider] = useState(providers[0] ?? '')
  const [view, setView] = useState<View | null>(null)
  const [accounts, setAccounts] = useState<{ accountId: string; label: string }[]>([])
  const [accountId, setAccountId] = useState('')
  const [snapshot, setSnapshot] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState('')
  const endpoint = `/api/connections/${encodeURIComponent(connectionId)}/monitor`
  useEffect(() => {
    const controller = new AbortController()
    async function read() {
      try {
        setView(await apiGet<View>(endpoint, controller.signal))
      } catch (e) {
        if (!controller.signal.aborted) setError(errorMessage(e))
      }
    }
    void read()
    // Re-read only saved monitoring data so staleness changes without provider requests.
    const timer = setInterval(() => void read(), 30_000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [endpoint])
  async function preview(value: unknown = snapshot) {
    setBusy(true)
    setError('')
    setAccounts([])
    setAccountId('')
    try {
      const data = await apiSend<{ accounts: { accountId: string; label: string }[] }>(endpoint, 'POST', {
        action: 'preview',
        providerId: provider,
        ...(value === undefined ? {} : { snapshot: value }),
      })
      setAccounts(data.accounts)
      if (!data.accounts.length) setError('快照未提供可唯一识别的账户。单账户需要未脱敏邮箱，多账户需要稳定账户 ID。')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  async function save(refresh: boolean) {
    setBusy(true)
    setError('')
    try {
      const data = await apiSend<{ observation: CollectorObservation }>(
        endpoint,
        'POST',
        refresh
          ? { action: 'refresh' }
          : { action: 'import', providerId: provider, accountId, ...(snapshot === undefined ? {} : { snapshot }) },
      )
      setView((current) => (current ? { ...current, observation: data.observation } : null))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const observation = view?.observation
  const writable = canManage && view?.canManage
  if (!providers.length) return null
  return (
    <section aria-label="订阅额度监测" className={styles.accountSection}>
      <h3>订阅额度监测 · CodexBar</h3>
      <p>按账户采集额度窗口，属于采集器上报数据。仅用于监测，不参与渠道路由、官方配额账本或费用结算。</p>
      <p>
        <strong>{observation ? labels[observation.state] : '尚未绑定账户'}</strong>
        {observation && (
          <>
            {' '}
            · {observation.providerId} · 账户 {observation.accountId.slice(0, 12)} · 更新于{' '}
            {observation.observedAt ? new Date(observation.observedAt).toLocaleString('zh-CN') : '未知'}
          </>
        )}
      </p>
      {observation?.state === 'error' && <p role="status">本次采集失败，下列数值为此前记录，请勿当作当前余额。</p>}
      {observation?.windows.map((window, index) => (
        <p key={`${window.kind}-${index}`}>
          {window.label}：已用 {window.usedPercent === null ? '未知' : `${window.usedPercent}%`}；剩余{' '}
          {window.remainingPercent === null ? '未知' : `${window.remainingPercent}%`}
          {window.resetAt && <>；重置 {new Date(window.resetAt).toLocaleString('zh-CN')}</>}
        </p>
      ))}
      {observation && !observation.windows.length && <p>采集源未返回额度窗口；未知值不会记作零。</p>}
      {error && <p role="alert">{error}</p>}
      {writable && (
        <>
          <label>
            采集器供应商{' '}
            <select
              value={provider}
              disabled={busy}
              onChange={(e) => {
                setProvider(e.target.value)
                setAccounts([])
                setAccountId('')
              }}
            >
              {providers.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <p>
            {view.configured
              ? '服务器已配置组织专属采集器，可读取与刷新。'
              : '服务器未配置本组织采集器，可导入 dashboard-v1 JSON 快照。'}
          </p>
          <label>
            导入 CodexBar 快照 JSON{' '}
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                setError('')
                setAccounts([])
                setAccountId('')
                setSnapshot(undefined)
                setFileName('')
                if (file.size > 1_000_000) {
                  setError('快照不能超过 1 MB')
                  return
                }
                try {
                  const value: unknown = JSON.parse(await file.text())
                  setSnapshot(value)
                  setFileName(file.name)
                  await preview(value)
                } catch {
                  setError('无法读取 JSON 快照')
                }
              }}
            />
          </label>
          {fileName && <p>已选择 {fileName}。仅保存绑定账户的额度窗口，快照原文不会持久化。</p>}
          <div>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy || (!snapshot && (!view.configured || !view.canRefresh))}
              onClick={() => void preview()}
            >
              读取可绑定账户
            </button>
            {snapshot !== undefined && (
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                onClick={() => {
                  setSnapshot(undefined)
                  setFileName('')
                  setAccounts([])
                  setAccountId('')
                }}
              >
                改用服务器采集器
              </button>
            )}
          </div>
          {accounts.length > 0 && (
            <label>
              明确选择账户{' '}
              <select disabled={busy} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">请选择账户</option>
                {accounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div>
            <button
              className={styles.primary}
              type="button"
              disabled={busy || !accountId}
              onClick={() => void save(false)}
            >
              绑定并保存监测
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy || !view.configured || !view.canRefresh || !observation}
              onClick={() => void save(true)}
            >
              从采集器刷新
            </button>
          </div>
          <p>
            快照命令：<code>codexbar dashboard &gt; snapshot.json</code>。采集器配置与登录在其运行主机上完成。
          </p>
        </>
      )}
    </section>
  )
}
