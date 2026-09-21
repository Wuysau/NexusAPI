'use client'

import { useState } from 'react'
import { ArrowDownToLine, Info, Search } from 'lucide-react'
import { HelpDetails } from '@/components/HelpDetails'
import { useApiData } from './lib/useApiData'
import { useSession } from './SessionProvider'
import { useToast } from './Toast'
import { Badge, fullDate } from './ui'
import { EmptyState, ErrorState, PermissionDenied, SkeletonRows } from './States'

interface AuditEvent {
  id: string
  actorUserId: string | null
  tenantId?: string | null
  action: string
  targetType: string | null
  targetId: string | null
  metadata: Record<string, unknown>
  ip: string | null
  traceId: string | null
  createdAt: string
  redacted: boolean
}

export function AuditLog() {
  const { can } = useSession()
  const { notify } = useToast()
  const [action, setAction] = useState('')
  const [query, setQuery] = useState('')

  const params = new URLSearchParams({ limit: '200' })
  if (action.trim()) params.set('action', action.trim())
  const state = useApiData<{ events: AuditEvent[]; redacted: boolean }>(`/api/audit?${params.toString()}`)

  if (state.forbidden) return <PermissionDenied capability="audit:read" />

  const events = (state.data?.events ?? []).filter((event) => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return `${event.action} ${event.targetType ?? ''} ${event.targetId ?? ''} ${event.actorUserId ?? ''}`
      .toLowerCase()
      .includes(q)
  })

  async function exportCsv() {
    try {
      const res = await fetch('/api/audit?format=csv', { credentials: 'same-origin' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(body?.error?.message ?? '导出失败')
      }
      const blob = await res.blob()
      const anchor = document.createElement('a')
      anchor.href = URL.createObjectURL(blob)
      anchor.download = 'nexus-audit.csv'
      anchor.click()
      URL.revokeObjectURL(anchor.href)
    } catch (error) {
      notify(error instanceof Error ? error.message : '导出失败', 'error')
    }
  }

  return (
    <>
      {state.data?.redacted && (
        <div className="perm-note" style={{ marginBottom: 14 }}>
          <Info size={15} /> 当前角色仅可查看脱敏记录，操作者与来源 IP 已隐藏。
        </div>
      )}

      <section className="panel">
        <div className="toolbar">
          <div className="search-input">
            <Search size={15} />
            <input placeholder="搜索操作、目标或操作者..." value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="toolbar-filters">
            <input
              className="plain-select"
              placeholder="按操作名精确筛选"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              style={{ border: '1px solid var(--line)', borderRadius: 9, padding: '7px 10px' }}
            />
            {can('audit:export') && (
              <button className="button" onClick={exportCsv} disabled={!events.length}>
                <ArrowDownToLine size={14} /> 导出 CSV
              </button>
            )}
          </div>
        </div>

        {state.loading ? (
          <SkeletonRows rows={6} />
        ) : state.error && !state.data ? (
          <ErrorState message={state.error} onRetry={state.reload} />
        ) : events.length === 0 ? (
          <EmptyState
            title={query || action ? '没有匹配的审计记录' : '暂无审计记录'}
            description={query || action ? '试试其他关键词或清除筛选。' : undefined}
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作</th>
                  <th>目标</th>
                  <th>操作者</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="muted">{fullDate(event.createdAt)}</td>
                    <td>
                      <Badge tone="info">{event.action}</Badge>
                    </td>
                    <td className="muted">
                      {event.targetType ?? '—'}
                      {event.targetId ? ` · ${event.targetId.slice(0, 10)}` : ''}
                    </td>
                    <td className="muted">{event.actorUserId ? event.actorUserId.slice(0, 12) : '系统'}</td>
                    <td>
                      <HelpDetails label="查看详情">
                        <code style={{ fontSize: 11 }}>{JSON.stringify(event.metadata)}</code>
                      </HelpDetails>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <HelpDetails label="审计记录说明">
        <p>记录仅可追加，不能修改或删除；凭据与密钥操作写入前已脱敏。</p>
      </HelpDetails>
    </>
  )
}
