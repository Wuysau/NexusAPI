'use client'

import { useMemo, useState } from 'react'
import { ArrowDownToLine, ChevronLeft, ChevronRight, FileText, Search } from 'lucide-react'
import { providers as PROVIDER_DISPLAY } from '@/lib/catalog/display'
import { useApiData } from './lib/useApiData'
import { ProviderMark, RequestStatusBadge, money, num, shortDate } from './ui'
import { EmptyState, ErrorState, PermissionDenied, SkeletonRows } from './States'

interface LogEntry {
  id: string
  model: string
  upstreamModelId: string | null
  providerCode: string | null
  channelKind: string
  status: string
  inputTokens: string | null
  outputTokens: string | null
  charge: string
  currency: string
  cost: string | null
  errorCode: string | null
  latencyMs: number | null
  keyName: string | null
  startedAt: string
  completedAt: string | null
}

interface LogsResponse {
  total: string
  limit: number
  offset: number
  entries: LogEntry[]
}

const PAGE_SIZE = 20

export function LogTable({ compact = false }: { compact?: boolean }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [provider, setProvider] = useState('all')
  const [page, setPage] = useState(1)

  const path = useMemo(() => {
    if (compact) return '/api/logs?limit=5'
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
    if (query.trim()) params.set('q', query.trim())
    if (status !== 'all') params.set('status', status)
    if (provider !== 'all') params.set('provider', provider)
    return `/api/logs?${params.toString()}`
  }, [compact, page, query, status, provider])

  const state = useApiData<LogsResponse>(path)

  if (state.forbidden) return <PermissionDenied capability="request:read" />

  const entries = state.data?.entries ?? []
  const total = Number(state.data?.total ?? 0)

  function exportCsv() {
    const header = [
      '请求 ID',
      '模型',
      '供应商',
      '密钥',
      '状态',
      '输入 Tokens',
      '输出 Tokens',
      '费用',
      '延迟 ms',
      '时间',
    ]
    const lines = entries.map((entry) =>
      [
        entry.id,
        entry.model,
        entry.providerCode ?? '',
        entry.keyName ?? '',
        entry.status,
        entry.inputTokens,
        entry.outputTokens,
        entry.charge,
        entry.latencyMs ?? '',
        entry.startedAt,
      ]
        .map((value) => `"${String(value).replaceAll('"', '""')}"`)
        .join(','),
    )
    const csv = '﻿' + [header.join(','), ...lines].join('\n')
    const anchor = document.createElement('a')
    anchor.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    anchor.download = 'nexus-request-logs.csv'
    anchor.click()
    URL.revokeObjectURL(anchor.href)
  }

  return (
    <section className="panel">
      {!compact && (
        <div className="panel-heading">
          <h3>请求日志</h3>
          <button className="button" onClick={exportCsv} disabled={!entries.length}>
            <ArrowDownToLine size={15} /> 导出本页
          </button>
        </div>
      )}
      {!compact && (
        <div className="toolbar">
          <div className="search-input wide">
            <Search size={15} />
            <input
              placeholder="搜索模型、密钥或请求 ID..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
            />
          </div>
          <div className="toolbar-filters">
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value)
                setPage(1)
              }}
              aria-label="按供应商筛选"
            >
              <option value="all">全部供应商</option>
              {PROVIDER_DISPLAY.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(1)
              }}
              aria-label="按状态筛选"
            >
              <option value="all">全部状态</option>
              <option value="success">请求成功</option>
              <option value="error">请求失败</option>
            </select>
          </div>
        </div>
      )}

      {state.loading ? (
        <SkeletonRows rows={5} />
      ) : state.error && !state.data ? (
        <ErrorState message={state.error} onRetry={state.reload} />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<FileText size={30} />}
          title="暂无请求记录"
          description="接入渠道并使用 API 密钥发送请求后，调用记录会显示在这里。"
        />
      ) : (
        <>
          <div className="table-scroll">
            <table className="logs-table">
              <thead>
                <tr>
                  <th>请求时间</th>
                  <th>模型 / 供应商</th>
                  <th>密钥</th>
                  <th>
                    Tokens <span className="muted">↑↓</span>
                  </th>
                  <th>费用</th>
                  <th>响应时间</th>
                  <th>状态</th>
                  {!compact && <th>请求 ID</th>}
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="tabular muted">{shortDate(entry.startedAt)}</td>
                    <td>
                      <span className="model-label">
                        <ProviderMark code={entry.providerCode} small />
                        {entry.model}
                      </span>
                    </td>
                    <td className="muted">{entry.keyName ?? '—'}</td>
                    <td className="tabular">
                      {entry.inputTokens == null || entry.outputTokens == null
                        ? '未知'
                        : num((BigInt(entry.inputTokens) + BigInt(entry.outputTokens)).toString())}
                    </td>
                    <td className="tabular">{money(entry.charge, 4, entry.currency)}</td>
                    <td className="tabular muted">
                      {entry.latencyMs === null ? '—' : (entry.latencyMs / 1000).toFixed(2) + ' s'}
                    </td>
                    <td>
                      <RequestStatusBadge status={entry.status} />
                    </td>
                    {!compact && (
                      <td className="tabular muted">
                        <details>
                          <summary>{entry.id.slice(0, 12)}</summary>
                          <code>{entry.id}</code>
                          <p>来源：网关请求记录 · {entry.startedAt}</p>
                          <p>
                            实际模型：{entry.upstreamModelId ?? '未知'} · 凭据记录：{entry.keyName ?? '未知'}
                          </p>
                        </details>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!compact && (
            <div className="pagination">
              <span>共 {num(total)} 条记录</span>
              <div>
                <button disabled={page === 1} aria-label="上一页" onClick={() => setPage(page - 1)}>
                  <ChevronLeft size={16} />
                </button>
                <span>
                  {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}
                </span>
                <button disabled={page * PAGE_SIZE >= total} aria-label="下一页" onClick={() => setPage(page + 1)}>
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
