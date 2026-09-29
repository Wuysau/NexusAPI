'use client'
import { useMemo, useState } from 'react'
import { HelpDetails } from '@/components/HelpDetails'
import { useApiData } from '@/components/lib/useApiData'
import { apiGet, errorMessage } from '@/components/lib/api'
import { count, localDate, WorkspaceNotice } from './Workspace'
import {
  sessionTokenNames,
  tokenShare,
  type SessionDetail,
  type SessionDetailsResponse,
  type SessionTokens,
} from '@/lib/billing/session-types'
import styles from './workspace.module.css'

interface SessionNode {
  session: SessionDetail
  children: SessionNode[]
}
const kindLabels: Record<string, string> = {
  desktop: '桌面对话',
  subagent: '子代理',
  cli: '命令行会话',
  other: '其他会话',
}
const tokenLabels = { input: '输入', cached: '缓存输入', reasoning: '推理输出', output: '输出', total: '总计' }
const agentToolLabels: Record<string, string> = { codex_local: 'Codex', claude_code_local: 'Claude Code' }
function forest(sessions: SessionDetail[]) {
  const map = new Map(
    sessions.map((session) => [`${session.usageSource}:${session.id}`, { session, children: [] } as SessionNode]),
  )
  const roots: SessionNode[] = []
  for (const node of map.values()) {
    const key = (id: string) => `${node.session.usageSource}:${id}`
    let id = node.session.parentId,
      cycle = false
    const visited = new Set([node.session.id])
    while (id && map.has(key(id))) {
      if (visited.has(id)) {
        cycle = true
        break
      }
      visited.add(id)
      id = map.get(key(id))!.session.parentId
    }
    const parent = !cycle && node.session.parentId ? map.get(key(node.session.parentId)) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
function TokenBreakdown({
  tokens,
  subscription,
  denominator,
}: {
  tokens: SessionTokens
  subscription: SessionTokens
  denominator: SessionTokens
}) {
  return (
    <dl className={styles.sessionTokenGrid}>
      {sessionTokenNames.map((key) => (
        <div key={key}>
          <dt>{tokenLabels[key]}</dt>
          <dd>{tokens[key] === null ? '未知' : count(tokens[key]!)}</dd>
          <small
            className={styles.sessionShare}
            title={`订阅同项分子：${subscription[key] ?? '未知'}；当前查询订阅同项分母：${denominator[key] ?? '未知'}`}
          >
            订阅占比 {tokenShare(subscription[key], denominator[key]) ?? '未知'}
          </small>
        </div>
      ))}
    </dl>
  )
}
function SessionBranch({ node, depth, denominator }: { node: SessionNode; depth: number; denominator: SessionTokens }) {
  const s = node.session
  const kind = kindLabels[s.kind ?? ''] ?? '类型未知'
  return (
    <div className={depth ? styles.sessionChild : styles.sessionRoot}>
      <article
        className={styles.sessionCard}
        aria-label={`${agentToolLabels[s.usageSource] ?? '工具未知'} 会话 ${s.id}`}
      >
        <div className={styles.sessionCardHeader}>
          <div className={styles.sessionBadges}>
            <span className={styles.badge}>Agent 工具：{agentToolLabels[s.usageSource] ?? '未知'}</span>
            <span className={styles.mutedBadge}>{kind}</span>
          </div>
          <strong>会话 {s.id.slice(0, 8)}</strong>
        </div>
        <div className={styles.sessionMeta}>
          <span>最近活动：{localDate(s.lastActivity)}</span>
          <span>模型：{s.models.join(' / ') || '未知'}</span>
          {s.parentId && <span>父会话：{s.parentId.slice(0, 8)}</span>}
          {node.children.length > 0 && <span>已加载子会话：{node.children.length}</span>}
        </div>
        <div className={styles.sessionMetrics}>
          <div>
            <span>本会话 Token</span>
            <strong>{s.tokens.total === null ? '未知' : count(s.tokens.total)}</strong>
          </div>
          <div>
            <span>观测事件</span>
            <strong>{count(s.events)}</strong>
          </div>
        </div>
        <details className={styles.sessionBreakdown}>
          <summary>查看 Token 构成与完整 ID</summary>
          <p className={styles.hint}>
            会话 ID：<code>{s.id}</code>
          </p>
          {s.connectionIds.length > 0 && (
            <p className={styles.hint}>
              关联连接：<code>{s.connectionIds.join('、')}</code>
            </p>
          )}
          <p className={styles.hint}>以下数值只属于本会话，不重复加上子会话。</p>
          <TokenBreakdown tokens={s.tokens} subscription={s.subscriptionTokens} denominator={denominator} />
        </details>
      </article>
      {node.children.map((child) => (
        <SessionBranch key={child.session.id} node={child} depth={depth + 1} denominator={denominator} />
      ))}
    </div>
  )
}
export function SessionDetails({ query, groupKey, asOf }: { query: string; groupKey: string | null; asOf: string }) {
  const endpoint = useMemo(() => {
    const params = new URLSearchParams(query.split('?')[1])
    params.set('asOf', asOf)
    params.set('offset', '0')
    params.set('limit', '100')
    params.delete('cursor')
    if (groupKey !== null) params.set('groupKey', groupKey)
    return '/api/billing/sessions?' + params
  }, [query, groupKey, asOf])
  const state = useApiData<SessionDetailsResponse>(endpoint)
  const [extra, setExtra] = useState<SessionDetail[]>([]),
    [next, setNext] = useState<number | null | undefined>(undefined)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const all = [...(state.data?.sessions ?? []), ...extra],
    nodes = forest(all)
  const offset = next === undefined ? state.data?.nextOffset : next
  async function more() {
    if (offset == null || busy) return
    setBusy(true)
    setError('')
    try {
      const url = new URL(endpoint, window.location.origin)
      url.searchParams.set('offset', String(offset))
      const data = await apiGet<SessionDetailsResponse>(url.pathname + url.search)
      setExtra([...extra, ...data.sessions])
      setNext(data.nextOffset)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.sessionDetails}>
      <div className={styles.accountHeading}>
        <strong>逐条会话记录</strong>
        <span className={styles.mutedBadge}>本地 Agent 会话</span>
      </div>
      <p className={styles.hint}>每张卡片是一条会话，可直接查看 Agent 工具、会话类型、模型、时间和本会话 Token。</p>
      <HelpDetails label="统计口径与隐私">
        <p>
          每项百分比 = 该会话的订阅同项 Token ÷ 当前查询范围的订阅同项 Token
          总量，不随展开的分组改变。缓存包含在输入中，推理包含在输出中，请勿将各列相加。
        </p>
        <p>
          Agent 工具由导入器确定，支持 Codex 与 Claude Code。对话按会话 ID 和时间识别，不保存正文或标题。 Claude Code
          自定义渠道日志未提供渠道身份时，供应商、连接和订阅保持未知；模型名不能证明订阅归属。只展示明确的父子关联。
        </p>
        <p>父会话不在当前筛选或已加载结果中时，子会话单独列出。来源：client_observed；本地记录不代表网关请求或账单。</p>
      </HelpDetails>
      {(state.error || error) && (
        <WorkspaceNotice error>
          {state.error || error}
          <button className={styles.link} onClick={state.reload}>
            重试
          </button>
        </WorkspaceNotice>
      )}
      {state.loading && !state.data ? (
        <p>正在读取会话…</p>
      ) : (
        state.data && (
          <>
            <p className={styles.hint}>
              已加载 {all.length} / {state.data.totalSessions} 个会话
            </p>
            <div className={styles.sessionList}>
              {nodes.map((node) => (
                <SessionBranch
                  key={`${node.session.usageSource}:${node.session.id}`}
                  node={node}
                  depth={0}
                  denominator={state.data!.subscriptionTotals}
                />
              ))}
            </div>
            {!all.length && <p className={styles.hint}>当前分组没有可见的本地会话。</p>}
            {offset != null && (
              <button className={styles.secondary} disabled={busy} onClick={() => void more()}>
                {busy ? '载入中…' : '载入更多会话'}
              </button>
            )}
          </>
        )
      )}
    </div>
  )
}
