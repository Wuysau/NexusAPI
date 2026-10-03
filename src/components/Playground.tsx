'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2, Send, Square, Trash2 } from 'lucide-react'
import { useSession } from './SessionProvider'
import { useApiData } from './lib/useApiData'
import { apiSend, ApiError } from './lib/api'
import { ErrorState, PermissionDenied, SkeletonRows } from './States'
import {
  PLAYGROUND_LIMITS,
  type PlaygroundChatResponse,
  type PlaygroundMessage,
  type PlaygroundModelsResponse,
} from '../../packages/contracts/playground'

interface Project {
  id: string
  name: string
  status: string
}
interface Turn {
  user: string
  result: PlaygroundChatResponse
}

/** Project changes unmount transient Key, output and request ownership together. */
export function Playground() {
  const { can, session } = useSession()
  const projects = useApiData<{ projects: Project[] }>(can('apikey:create') ? '/api/projects?status=active' : null)
  const [selected, setSelected] = useState('')
  const available = projects.data?.projects.filter((project) => project.status === 'active') ?? []
  const projectId = available.some((project) => project.id === selected) ? selected : ''
  if (!can('apikey:create')) return <PermissionDenied capability="apikey:create" />
  if (projects.loading) return <SkeletonRows rows={3} />
  if (projects.error && !projects.data) return <ErrorState message={projects.error} onRetry={projects.reload} />
  return (
    <section className="panel form-body playground-panel" aria-label="项目在线调试">
      <div className="playground-controls">
        <label>
          调试项目
          <select aria-label="调试项目" value={projectId} onChange={(event) => setSelected(event.target.value)}>
            <option value="">选择项目</option>
            {available.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {projects.error && <p role="alert">项目列表刷新失败，请重新加载后确认项目权限。</p>}
      {projectId ? (
        <Conversation
          key={`${session?.organization.tenantId}:${session?.user.id}:${projectId}`}
          projectId={projectId}
        />
      ) : (
        <p className="muted">请选择有权限的活跃项目，然后输入该项目的 API Key。</p>
      )}
    </section>
  )
}

function Conversation({ projectId }: { projectId: string }) {
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<{ id: string }[]>([])
  const [model, setModel] = useState('')
  const [maxTokens, setMaxTokens] = useState(1024)
  const [draft, setDraft] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [busy, setBusy] = useState<'models' | 'chat' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const work = useRef<{ alive: boolean; version: number; controller: AbortController | null }>({
    alive: false,
    version: 0,
    controller: null,
  })
  useEffect(() => {
    const scope = work.current
    scope.alive = true
    return () => {
      scope.alive = false
      scope.version++
      scope.controller?.abort()
      scope.controller = null
    }
  }, [])
  function stop() {
    work.current.version++
    work.current.controller?.abort()
    work.current.controller = null
    setBusy(null)
    setPendingText(null)
  }
  function clearConversation() {
    stop()
    setTurns([])
    setDraft('')
    setError(null)
    setNotice(null)
  }
  function replaceKey(value: string) {
    clearConversation()
    setApiKey(value)
    setModels([])
    setModel('')
  }
  function cancel() {
    stop()
    setError(null)
    setNotice('已取消；调用可能已产生用量，不会自动重发。未完成的消息未加入对话。')
  }
  function begin(kind: 'models' | 'chat') {
    if (work.current.controller || !work.current.alive) return null
    const controller = new AbortController()
    const version = ++work.current.version
    work.current.controller = controller
    setBusy(kind)
    setError(null)
    setNotice(null)
    const current = () =>
      work.current.alive &&
      work.current.version === version &&
      work.current.controller === controller &&
      !controller.signal.aborted
    return { controller, current }
  }
  function failed(reason: unknown) {
    setError(reason instanceof ApiError ? reason.message : '调用结果未知，可能已产生用量；不会自动重发。')
  }
  async function discover() {
    const request = begin('models')
    if (!request) return
    try {
      const result = await apiSend<PlaygroundModelsResponse>(
        '/api/playground/models',
        'POST',
        { projectId, apiKey },
        request.controller.signal,
      )
      if (!request.current()) return
      setModels(result.models)
      const nextModel = result.models.some((item) => item.id === model) ? model : (result.models[0]?.id ?? '')
      if (nextModel !== model) {
        setTurns([])
        setDraft('')
      }
      setModel(nextModel)
      if (!result.models.length) setNotice('网关未返回此 Key 可用的模型。模型列表不保证请求能通过实时额度与资源策略。')
    } catch (reason) {
      if (request.current()) {
        setModels([])
        setModel('')
        failed(reason)
      }
    } finally {
      if (request.current()) {
        work.current.controller = null
        setBusy(null)
      }
    }
  }
  const history: PlaygroundMessage[] = turns.flatMap((turn) => [
    { role: 'user' as const, content: turn.user },
    { role: 'assistant' as const, content: turn.result.assistant.content ?? '' },
  ])
  const canContinue = turns.every((turn) => turn.result.canContinue)
  const full = history.length + 1 > PLAYGROUND_LIMITS.messages
  async function send(event: FormEvent) {
    event.preventDefault()
    if (!draft.trim() || !model || !apiKey || !canContinue || full || busy) return
    const input = {
      projectId,
      apiKey,
      model,
      messages: [...history, { role: 'user' as const, content: draft }],
      maxTokens,
    }
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > PLAYGROUND_LIMITS.inputBytes) {
      setError('完整调试请求最多 65536 字节；请缩短文本或清空对话。')
      return
    }
    const request = begin('chat')
    if (!request) return
    const user = draft
    setPendingText(user)
    setDraft('')
    try {
      const result = await apiSend<PlaygroundChatResponse>(
        '/api/playground/chat',
        'POST',
        input,
        request.controller.signal,
      )
      if (!request.current()) return
      setTurns((previous) => [...previous, { user, result }])
    } catch (reason) {
      if (request.current()) failed(reason)
    } finally {
      if (request.current()) {
        work.current.controller = null
        setBusy(null)
        setPendingText(null)
      }
    }
  }
  return (
    <>
      <p className="muted">
        通过 Gateway 执行真实调用并产生用量。Key、对话和输出仅保留在当前页面内存；更换项目或 Key
        会清空。取消无法撤销已产生的用量。
      </p>
      <div className="playground-controls">
        <label>
          项目 API Key
          <input
            aria-label="调试项目 API Key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => replaceKey(event.target.value)}
            placeholder="sk-nx-…"
          />
        </label>
        <button className="button" type="button" disabled={!apiKey || busy !== null} onClick={() => void discover()}>
          {busy === 'models' && <Loader2 size={15} className="spin" />}获取可用模型
        </button>
        <label>
          调试模型
          <select
            aria-label="调试模型"
            value={model}
            disabled={busy !== null || !models.length}
            onChange={(event) => {
              clearConversation()
              setModel(event.target.value)
            }}
          >
            {!models.length && <option value="">先获取模型</option>}
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          最大输出 Token
          <input
            aria-label="最大输出 Token"
            type="number"
            min={1}
            max={PLAYGROUND_LIMITS.outputTokens}
            value={maxTokens}
            disabled={busy !== null}
            onChange={(event) => setMaxTokens(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="playground-conversation" aria-label="调试对话" aria-live="polite">
        {turns.map((turn, index) => (
          <article className="panel playground-turn" key={index}>
            <p>
              <strong>用户</strong>
            </p>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{turn.user}</p>
            <p>
              <strong>助手</strong>
            </p>
            {turn.result.assistant.content ? (
              <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{turn.result.assistant.content}</p>
            ) : (
              <p className="muted">未返回可见文本。</p>
            )}
            {turn.result.assistant.refusal !== null && (
              <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                拒绝信息：{turn.result.assistant.refusal || '（空）'}
              </p>
            )}
            <p className="muted">
              输入 {turn.result.usage.inputTokens ?? '未知'} · 输出 {turn.result.usage.outputTokens ?? '未知'} ·
              缓存输入 {turn.result.usage.cachedInputTokens ?? '未知'} · 推理{' '}
              {turn.result.usage.reasoningTokens ?? '未知'} · 总计 {turn.result.usage.totalTokens ?? '未知'} Token ·
              结束原因 {turn.result.finishReason ?? '未知'}
            </p>
            {turn.result.requestId ? (
              <p>
                请求 ID：
                <Link href={`/logs?requestId=${encodeURIComponent(turn.result.requestId)}`}>
                  {turn.result.requestId}
                </Link>
              </p>
            ) : (
              <p className="muted">网关未提供可关联的请求 ID。</p>
            )}
          </article>
        ))}
        {pendingText !== null && (
          <article className="panel playground-turn">
            <p>
              <strong>待完成消息</strong>
            </p>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{pendingText}</p>
            <p className="muted">等待网关响应…</p>
          </article>
        )}
      </div>
      {!canContinue && (
        <p role="status">
          回复包含推理、工具调用、拒绝信息、其他助手字段或不完整文本。本调试器无法安全继续该上下文，请清空对话后发起新请求。
        </p>
      )}
      {full && <p role="status">对话已达到消息数上限，请清空对话。</p>}
      {error && <p role="alert">{error} 未完成的消息未加入对话。</p>}
      {notice && <p role="status">{notice}</p>}
      <form className="playground-compose" onSubmit={(event) => void send(event)}>
        <label>
          消息
          <textarea
            aria-label="调试消息"
            rows={5}
            value={draft}
            disabled={busy !== null || !canContinue || full}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="输入文本消息"
          />
        </label>
        <div className="playground-actions">
          <button
            className="button primary"
            type="submit"
            disabled={
              busy !== null ||
              !apiKey ||
              !model ||
              !draft.trim() ||
              !canContinue ||
              full ||
              !Number.isSafeInteger(maxTokens) ||
              maxTokens < 1 ||
              maxTokens > PLAYGROUND_LIMITS.outputTokens
            }
          >
            {busy === 'chat' ? <Loader2 size={15} className="spin" /> : <Send size={15} />}发送（产生真实用量）
          </button>
          {busy !== null && (
            <button className="button" type="button" onClick={cancel}>
              <Square size={15} />
              取消调用
            </button>
          )}
          <button className="button" type="button" onClick={clearConversation}>
            <Trash2 size={15} />
            清空对话
          </button>
        </div>
      </form>
    </>
  )
}
