'use client'
import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
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
function sumTokens(values: SessionTokens[]): SessionTokens {
  return Object.fromEntries(
    sessionTokenNames.map((key) => [
      key,
      values.some((v) => v[key] === null) ? null : values.reduce((sum, v) => sum + BigInt(v[key]!), 0n).toString(),
    ]),
  ) as SessionTokens
}
function descendants(node: SessionNode): SessionDetail[] {
  return [node.session, ...node.children.flatMap(descendants)]
}
function forest(sessions: SessionDetail[]) {
  const map = new Map(sessions.map((session) => [session.id, { session, children: [] } as SessionNode]))
  const roots: SessionNode[] = []
  for (const node of map.values()) {
    let id = node.session.parentId,
      cycle = false
    const visited = new Set([node.session.id])
    while (id && map.has(id)) {
      if (visited.has(id)) {
        cycle = true
        break
      }
      visited.add(id)
      id = map.get(id)!.session.parentId
    }
    const parent = !cycle && node.session.parentId ? map.get(node.session.parentId) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}
function TokenCells({
  tokens,
  subscription,
  denominator,
}: {
  tokens: SessionTokens
  subscription: SessionTokens
  denominator: SessionTokens
}) {
  return (
    <>
      {sessionTokenNames.map((key) => (
        <td key={key}>
          <span>{tokens[key] === null ? '未知' : count(tokens[key]!)}</span>
          <small
            className={styles.sessionShare}
            title={`订阅同项分子：${subscription[key] ?? '未知'}；当前查询订阅同项分母：${denominator[key] ?? '未知'}`}
          >
            {tokenShare(subscription[key], denominator[key]) ?? '占比未知'}
          </small>
        </td>
      ))}
    </>
  )
}
function SessionBranch({ node, depth, denominator }: { node: SessionNode; depth: number; denominator: SessionTokens }) {
  const [open, setOpen] = useState(false)
  const records = descendants(node),
    s = node.session
  const kind = kindLabels[s.kind ?? ''] ?? '类型未知'
  return (
    <Fragment>
      <tr className={node.children.length ? styles.sessionParent : undefined}>
        <td>
          <div className={styles.sessionIdentity} style={{ paddingLeft: Math.min(depth, 6) * 16 }}>
            {node.children.length > 0 && (
              <button
                className={styles.link}
                aria-expanded={open}
                aria-label={`${open ? '折叠' : '展开'} ${s.id} 子会话`}
                onClick={() => setOpen(!open)}
              >
                {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>
            )}
            <div>
              <strong>
                {kind} · {s.id.slice(0, 8)}
              </strong>
              <HelpDetails label="会话 ID">
                <p>{s.id}</p>
                {s.parentId && <p>父会话：{s.parentId}</p>}
              </HelpDetails>
              <small>
                {node.children.length
                  ? `自身及已加载的 ${records.length - 1} 个子会话合计`
                  : s.parentId
                    ? `父会话：${s.parentId.slice(0, 8)}`
                    : s.kind === 'cli'
                      ? '独立命令行会话'
                      : '会话自身用量'}
              </small>
              <small>
                {localDate(s.firstActivity)} — {localDate(s.lastActivity)}
              </small>
              <small>{[...new Set(records.flatMap((r) => r.models))].join(' / ') || '模型未知'}</small>
            </div>
          </div>
        </td>
        <TokenCells
          tokens={sumTokens(records.map((r) => r.tokens))}
          subscription={sumTokens(records.map((r) => r.subscriptionTokens))}
          denominator={denominator}
        />
      </tr>
      {open && (
        <>
          <tr>
            <td>
              <div className={styles.sessionIdentity} style={{ paddingLeft: Math.min(depth + 1, 6) * 16 }}>
                <span>
                  {kind}自身 · {count(s.events)} 条事件
                </span>
              </div>
            </td>
            <TokenCells tokens={s.tokens} subscription={s.subscriptionTokens} denominator={denominator} />
          </tr>
          {node.children.map((child) => (
            <SessionBranch key={child.session.id} node={child} depth={depth + 1} denominator={denominator} />
          ))}
        </>
      )}
    </Fragment>
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
        <strong>会话 Token 明细</strong>
        <span className={styles.mutedBadge}>本机记录</span>
      </div>
      <p className={styles.hint}>百分比为当前查询内的订阅用量占比，不是官方额度占比。</p>
      <HelpDetails label="统计口径与隐私">
        <p>
          每项百分比 = 该会话的订阅同项 Token ÷ 当前查询范围的订阅同项 Token
          总量，不随展开的分组改变。缓存包含在输入中，推理包含在输出中，请勿将各列相加。
        </p>
        <p>
          对话按会话 ID 和时间识别，不读取正文或标题。只展示明确的父子关联；命令行会话独立计量，单条 Shell 命令没有独立
          Token 统计。
        </p>
        <p>父会话不在当前筛选或已加载结果中时，子会话单独列出。来源：Codex local · client_observed。</p>
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
            <div className={styles.sessionTable}>
              <table>
                <thead>
                  <tr>
                    <th>对话 / 子会话</th>
                    {sessionTokenNames.map((key) => (
                      <th key={key}>
                        {tokenLabels[key]}
                        <small>数量 / 订阅同项占比</small>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((node) => (
                    <SessionBranch
                      key={node.session.id}
                      node={node}
                      depth={0}
                      denominator={state.data!.subscriptionTotals}
                    />
                  ))}
                </tbody>
              </table>
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
