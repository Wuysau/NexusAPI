'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiSend, errorMessage } from '@/components/lib/api'
import { useHighRiskAction } from '@/components/lib/useHighRiskAction'
import { ReauthDialog } from '@/components/ReauthDialog'
import { WorkspaceNotice, localDate } from '@/components/workspace/Workspace'
import styles from '@/components/workspace/workspace.module.css'

interface State {
  state: string
  models: string[]
  readyModels: string[]
  leaseExpiresAt: string | null
  transportSeenAt: string | null
}
const labels: Record<string, string> = {
  registered: '已登记 · 尚未建立租约',
  online: '连接器在线',
  offline: '连接器离线',
  expired: '租约已过期或已轮换',
  revoked: '已撤销',
}
export function LocalConnectorPanel({
  connectionId,
  revoked,
  canManage,
}: {
  connectionId: string
  revoked: boolean
  canManage: boolean
}) {
  const base = `/api/connections/${encodeURIComponent(connectionId)}/connector`
  const [state, setState] = useState<State | null>(null)
  const [models, setModels] = useState('qwen2.5:7b\nllama3.2:3b')
  const [pairing, setPairing] = useState<{ pairingToken: string; expiresAt: string } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [key, setKey] = useState('')
  const [model, setModel] = useState('')
  const modelsInitialized = useRef(false)
  const scope = useRef<AbortController | null>(null)
  const testRequest = useRef<AbortController | null>(null)
  const refreshVersion = useRef(0)
  const highRisk = useHighRiskAction()
  const clearPendingPairing = highRisk.clear
  const blocked = busy || highRisk.busy || highRisk.needsReauth
  const dialogLifetime = scope.current
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (signal.aborted) return
      const version = ++refreshVersion.current
      try {
        const next = await apiGet<State>(base, signal)
        if (signal.aborted || version !== refreshVersion.current) return
        setState(next)
        if (!modelsInitialized.current) {
          if (next.models.length) setModels(next.models.join('\n'))
          modelsInitialized.current = true
        }
      } catch (e) {
        if (!signal.aborted && version === refreshVersion.current) setError(errorMessage(e))
      }
    },
    [base],
  )
  useEffect(() => {
    const lifetime = new AbortController()
    scope.current = lifetime
    const timer = setTimeout(() => void refresh(lifetime.signal), 0)
    const interval = setInterval(() => void refresh(lifetime.signal), 5000)
    return () => {
      clearTimeout(timer)
      clearInterval(interval)
      lifetime.abort()
      clearPendingPairing()
      if (scope.current === lifetime) {
        scope.current = null
        const pending = testRequest.current
        testRequest.current = null
        pending?.abort()
      }
    }
  }, [refresh, clearPendingPairing])
  async function pair() {
    const lifetime = scope.current
    if (!lifetime || lifetime.signal.aborted || blocked) return
    const current = () => !lifetime.signal.aborted && scope.current === lifetime
    const approvedModels = models
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean)
    setError('')
    setPairing(null)
    try {
      await highRisk.run(async () => {
        if (!current()) return
        setBusy(true)
        try {
          const result = await apiSend<{ pairingToken: string; expiresAt: string }>(
            base,
            'POST',
            { models: approvedModels },
            lifetime.signal,
          )
          if (!current()) return
          setPairing(result)
          await refresh(lifetime.signal)
        } catch (e) {
          // An obsolete denial must not queue another action in the shared hook.
          if (current()) throw e
        } finally {
          if (current()) setBusy(false)
        }
      })
    } catch (e) {
      if (current()) setError(errorMessage(e))
    }
  }
  async function retryPair(lifetime: AbortController | null) {
    if (!lifetime || lifetime.signal.aborted || scope.current !== lifetime) return
    try {
      await highRisk.retry()
    } catch (e) {
      if (!lifetime.signal.aborted && scope.current === lifetime) setError(errorMessage(e))
    }
  }
  async function test() {
    const lifetime = scope.current
    if (!lifetime || lifetime.signal.aborted || blocked || testRequest.current) return
    const controller = new AbortController()
    testRequest.current = controller
    const current = () => !lifetime.signal.aborted && !controller.signal.aborted && testRequest.current === controller
    setBusy(true)
    setTesting(true)
    setError('')
    setNotice('')
    try {
      const result = await apiSend<{ message: string; requestId: string }>(
        base + '/test',
        'POST',
        { apiKey: key, model },
        controller.signal,
      )
      if (!current()) return
      setNotice(`${result.message} 请求 ID：${result.requestId}`)
      void refresh(lifetime.signal)
    } catch (e) {
      if (current()) setError(errorMessage(e))
    } finally {
      if (current()) {
        testRequest.current = null
        setKey('')
        setBusy(false)
        setTesting(false)
      }
    }
  }
  function cancelTest() {
    const pending = testRequest.current
    if (!pending) return
    testRequest.current = null
    pending.abort()
    setKey('')
    setBusy(false)
    setTesting(false)
    setError('')
    setNotice('测试已取消；已产生的用量仍会记录。')
  }
  return (
    <section className={styles.form} aria-label="本地连接器配置">
      <h3>Ollama 本地连接器</h3>
      <dl className={styles.details}>
        <dt>连接状态</dt>
        <dd>{labels[state?.state ?? 'registered']}</dd>
        <dt>租约到期</dt>
        <dd>{localDate(state?.leaseExpiresAt ?? null)}</dd>
        <dt>获批模型</dt>
        <dd>{state?.models.join('、') || '尚未配置'}</dd>
        <dt>模型就绪</dt>
        <dd>{state?.readyModels.join('、') || '暂无'}</dd>
      </dl>
      <WorkspaceNotice>
        模型就绪表示本机模型列表检查通过且连接器近期在线。测试调用成功才能确认当前模型完成了一次真实推理；所有调用仍须通过项目
        API Key 授权。
      </WorkspaceNotice>
      {!revoked && canManage && (
        <>
          <label className={styles.field}>
            批准的模型 ID（每行一个，与 Ollama 完全一致）
            <textarea
              aria-label="连接器模型 ID"
              rows={3}
              value={models}
              onChange={(e) => {
                modelsInitialized.current = true
                setModels(e.target.value)
              }}
            />
          </label>
          <p className={styles.hint}>生成新令牌会撤销旧连接器身份和租约。使用新的本机身份文件重新配对。</p>
          <button type="button" className={styles.primary} disabled={blocked} onClick={() => void pair()}>
            保存模型并生成一次性配对令牌 / 轮换身份
          </button>
          {pairing && (
            <WorkspaceNotice>
              <p>仅本次显示，有效期至 {localDate(pairing.expiresAt)}。在本机 pair 命令提示后粘贴：</p>
              <code style={{ overflowWrap: 'anywhere' }}>{pairing.pairingToken}</code>
              <p>
                <button type="button" className={styles.secondary} onClick={() => setPairing(null)}>
                  已保存，隐藏令牌
                </button>
              </p>
            </WorkspaceNotice>
          )}
          <details>
            <summary>本机安装、配置与启动</summary>
            <p>在装有 Go 的电脑上，从 NexusAPI 仓库构建：</p>
            <pre className={styles.code}>
              {'cd services/gateway\ngo build -o nexus-connector ./cmd/nexus-connector'}
            </pre>
            <p>本机创建 connector.json，替换远端地址和本机已有模型：</p>
            <pre className={styles.code}>
              {JSON.stringify(
                {
                  controlUrl: 'https://control.example.com',
                  gatewayUrl: 'https://gateway.example.com',
                  upstreamUrl: 'http://127.0.0.1:11434/v1',
                  models: models
                    .split(/[\n,]/)
                    .map((v) => v.trim())
                    .filter(Boolean),
                },
                null,
                2,
              )}
            </pre>
            <pre className={styles.code}>
              {
                './nexus-connector pair --config connector.json --identity connector-identity.json\n./nexus-connector run --config connector.json --identity connector-identity.json'
              }
            </pre>
            <p>
              Windows 使用 nexus-connector.exe。身份文件保存在本机私有目录。上游 API Key 如有需要，通过本机配置
              apiKeyEnv 指定环境变量。
            </p>
          </details>
        </>
      )}
      {!revoked && (
        <>
          <h4>通过项目 API Key 测试真实调用</h4>
          <label className={styles.field}>
            模型
            <select aria-label="测试连接器模型" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">选择就绪模型</option>
              {state?.readyModels.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            该项目的 Nexus API Key
            <input
              type="password"
              autoComplete="off"
              aria-label="连接器测试项目 API Key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <button
            type="button"
            className={styles.secondary}
            disabled={blocked || !key || !model}
            onClick={() => void test()}
          >
            {testing ? '测试调用进行中…' : '执行测试调用（产生真实用量）'}
          </button>
          {testing && (
            <button type="button" className={styles.secondary} onClick={cancelTest}>
              取消测试
            </button>
          )}
        </>
      )}
      {error && <WorkspaceNotice error>{error}</WorkspaceNotice>}
      {notice && <WorkspaceNotice>{notice}</WorkspaceNotice>}
      {highRisk.needsReauth && (
        <ReauthDialog
          onClose={() => {
            if (dialogLifetime && !dialogLifetime.signal.aborted && scope.current === dialogLifetime)
              clearPendingPairing()
          }}
          onSuccess={() => void retryPair(dialogLifetime)}
        />
      )}
    </section>
  )
}
