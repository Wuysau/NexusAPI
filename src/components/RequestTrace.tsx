'use client'

import { X } from 'lucide-react'
import {
  validateRequestTrace,
  type RequestTrace as RecordedTrace,
  type TracePins,
  type TraceSettlement,
  type TraceTiming,
  type TraceUsage,
} from '../../packages/contracts/request-trace'
import { fromMicros } from '@/lib/money'
import { useApiData } from './lib/useApiData'
import { EmptyState, ErrorState, LoadingState, PermissionDenied } from './States'
import { Badge, RequestStatusBadge, fullDate, money, num } from './ui'

const unknown = (value: string | null) => value ?? '未知'

function Timing({ value }: { value: TraceTiming }) {
  return (
    <p className="muted">
      {fullDate(value.startedAt)} → {value.completedAt ? fullDate(value.completedAt) : '尚未记录结束'}
      {' · '}耗时：{value.durationMs === null ? '未知' : `${value.durationMs} ms`}
    </p>
  )
}
function Pins({ value }: { value: TracePins }) {
  return (
    <p className="muted" style={{ overflowWrap: 'anywhere' }}>
      策略版本：{unknown(value.policyVersionId)} · 目录版本：{unknown(value.catalogVersionId)} · 价格版本：
      {unknown(value.priceVersionId)}
    </p>
  )
}
function Usage({ value }: { value: TraceUsage }) {
  return (
    <div>
      <p>
        输入：{num(value.inputTokens)} · 输出：{num(value.outputTokens)} · 缓存输入：{num(value.cachedInputTokens)} ·
        推理：{num(value.reasoningTokens)} · 总量：{num(value.totalTokens)}
      </p>
      <p className="muted">
        用量依据：{value.source === 'worker' ? 'Worker 验证计量' : value.source === 'event' ? '已捕获用量事件' : '未知'}
        {value.schemaVersion !== null && ` · v${value.schemaVersion}`}
        {value.estimated === true && ' · 估算值'}
      </p>
    </div>
  )
}
function Settlement({ value }: { value: TraceSettlement | null }) {
  return (
    <p>
      结算费用：
      {money(
        value?.chargeMicros == null ? null : fromMicros(BigInt(value.chargeMicros)),
        6,
        value?.chargeCurrency ?? null,
      )}
      {' · '}上游成本：
      {money(
        value?.upstreamCostMicros == null ? null : fromMicros(BigInt(value.upstreamCostMicros)),
        6,
        value?.upstreamCostCurrency ?? null,
      )}
      {value ? (
        <span className="muted"> · 结算记录：{value.usageRecordId}</span>
      ) : (
        <span className="muted"> · 尚无结算依据</span>
      )}
    </p>
  )
}

/** Parent keys this panel by request, query scope and session ownership. */
export function RequestTrace({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const state = useApiData<unknown>(`/api/logs/${encodeURIComponent(requestId)}/trace`)
  const trace: RecordedTrace | null =
    validateRequestTrace(state.data) && state.data.request.id === requestId ? state.data : null
  return (
    <section className="panel" aria-label="请求执行详情" style={{ marginTop: 16 }}>
      <div className="panel-heading">
        <h3>请求执行详情</h3>
        <button className="button" onClick={onClose} aria-label="关闭请求详情">
          <X size={15} /> 关闭
        </button>
      </div>
      <div style={{ padding: 20, overflowWrap: 'anywhere' }}>
        {state.forbidden ? (
          <PermissionDenied capability="request:read" />
        ) : state.loading ? (
          <LoadingState label="读取已记录的请求…" />
        ) : state.error ? (
          <ErrorState message={state.error} onRetry={state.reload} />
        ) : !trace ? (
          <ErrorState message="请求详情响应无效。" onRetry={state.reload} />
        ) : (
          <>
            <div style={{ display: 'grid', gap: 8 }}>
              <p>
                <code>{trace.request.id}</code> · <RequestStatusBadge status={trace.request.status} />
              </p>
              <p>
                请求模型：{trace.request.requestedModel} · 历史项目：{unknown(trace.request.project.name)} (
                {unknown(trace.request.project.id)})
              </p>
              <p className="muted">
                归属：{trace.request.project.attributionStatus} · Trace ID：{unknown(trace.request.traceId)} · API Key
                ID：{unknown(trace.request.apiKeyId)}
              </p>
              <Timing value={trace.request.timing} />
              {trace.request.errorCode && (
                <p>
                  错误代码：<code>{trace.request.errorCode}</code>
                </p>
              )}
              <Pins value={trace.request.pins} />
              <Usage value={trace.request.usage} />
              <Settlement value={trace.request.settlement} />
            </div>
            <p className="security-note" style={{ marginTop: 16 }}>
              仅展示网关已持久化的请求和尝试；尚未落库的入口拒绝不在此视图中。不采集提示词或响应内容。 任务 /
              会话关联、首 Token 延迟与流式时长：未知。缺少用量或价格依据的值保持未知。
            </p>
            <h3 style={{ marginTop: 20 }}>已记录尝试 ({num(trace.attemptCount)})</h3>
            {trace.truncated && (
              <p role="status" className="security-note">
                共 {num(trace.attemptCount)} 次尝试，仅展示前 {trace.attemptLimit} 次；此列表不完整。
              </p>
            )}
            {trace.attempts.length === 0 ? (
              <EmptyState title="尚无已记录尝试" description="请求记录可能仍在处理中，或未产生可持久化的尝试。" />
            ) : (
              <ol
                aria-label="按执行顺序排列的尝试"
                style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 14, marginTop: 12 }}
              >
                {trace.attempts.map((attempt) => (
                  <li key={attempt.id} className="panel" style={{ padding: 16, display: 'grid', gap: 8 }}>
                    <p>
                      <strong>尝试 #{attempt.number}</strong> · <Badge>{attempt.status}</Badge> ·{' '}
                      <code>{attempt.id}</code>
                    </p>
                    <p>
                      实际供应商：{unknown(attempt.providerId)} · 实际模型：{unknown(attempt.resolvedModel)}
                    </p>
                    <p className="muted">
                      Channel：{unknown(attempt.channelId)} · Connection：{unknown(attempt.connectionId)} · 执行模式：
                      {attempt.executionMode}
                    </p>
                    <p className="muted">
                      供应商请求 ID：<code>{unknown(attempt.providerRequestId)}</code>
                    </p>
                    {attempt.errorCode && (
                      <p>
                        错误代码：<code>{attempt.errorCode}</code>
                      </p>
                    )}
                    <Timing value={attempt.timing} />
                    <Pins value={attempt.pins} />
                    <Usage value={attempt.usage} />
                    <Settlement value={attempt.settlement} />
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </section>
  )
}
