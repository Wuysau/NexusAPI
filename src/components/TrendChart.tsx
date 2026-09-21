'use client'

import { useMemo, useState } from 'react'
import { EmptyState } from './States'
import { Activity } from 'lucide-react'

export interface SeriesPoint {
  bucket: number
  requests: number
  tokens: number | null
}

/**
 * Real-data trend chart. An all-zero window renders an empty state instead of
 * a synthetic curve (no fake production data on success pages).
 */
export function TrendChart({ series, rangeDays, from }: { series: SeriesPoint[]; rangeDays: number; from: string }) {
  const [metric, setMetric] = useState<'requests' | 'tokens'>('requests')
  const [hover, setHover] = useState<number | null>(null)
  // Anchor all time labels to the window start returned by the API. Deriving
  // them from Date.now() during render would make the component impure.
  const anchorMs = useMemo(() => new Date(from).getTime(), [from])

  const tokensKnown = series.every((p) => p.tokens !== null)
  const displayedMetric = metric === 'tokens' && tokensKnown ? 'tokens' : 'requests'
  const raw = series.map((p) => (displayedMetric === 'requests' ? p.requests : p.tokens!))
  const hasData = raw.some((v) => v > 0)

  if (!series.length || !hasData) {
    return (
      <section className="panel trend-panel">
        <div className="panel-heading">
          <div>
            <h3>请求趋势</h3>
            <p>了解您的 API 调用与 Token 消耗情况</p>
          </div>
        </div>
        <EmptyState
          icon={<Activity size={30} />}
          title="所选时段暂无请求"
          description="接入渠道并发送第一次请求后，趋势会显示在这里。"
        />
      </section>
    )
  }

  const max = Math.max(...raw, 1)
  const width = 704
  const height = 211
  const x0 = 46
  const x1 = 680
  const y0 = 32
  const y1 = 165
  const step = (x1 - x0) / Math.max(1, raw.length - 1)
  const pts = raw.map((v, i) => [x0 + i * step, y1 - (v / max) * (y1 - y0)] as const)
  const path = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')
  const bucketMs = (rangeDays * 86400000) / Math.max(1, raw.length - 1)

  return (
    <section className="panel trend-panel">
      <div className="panel-heading">
        <div>
          <h3>请求趋势</h3>
          <p>了解您的 API 调用与 Token 消耗情况</p>
        </div>
        <div className="segmented">
          <button className={displayedMetric === 'requests' ? 'selected' : ''} onClick={() => setMetric('requests')}>
            请求数
          </button>
          <button
            disabled={!tokensKnown}
            title={!tokensKnown ? '部分请求缺少 Token 凭证，无法绘制完整趋势' : undefined}
            className={displayedMetric === 'tokens' ? 'selected' : ''}
            onClick={() => setMetric('tokens')}
          >
            {tokensKnown ? 'Token 用量' : 'Token 数据不完整'}
          </button>
        </div>
      </div>
      <div className="chart-legend">
        <span>
          <i className="legend-dot green" />
          {displayedMetric === 'requests' ? '请求数' : 'Token 用量'}
        </span>
        <span className="chart-unit">{displayedMetric === 'requests' ? '单位：次' : '单位：Token'}</span>
      </div>
      <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${width} ${height}`} className="trend-svg" role="img" aria-label="API 请求量趋势图">
          <defs>
            <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
              <stop stopColor="#33ba97" stopOpacity=".18" />
              <stop offset="1" stopColor="#33ba97" stopOpacity=".015" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <line x1={x0} x2={x1} y1={y0 + i * 34} y2={y0 + i * 34} stroke="#edf0f1" strokeDasharray="3 4" />
              <text x={31} y={36 + i * 34} textAnchor="end" fill="#9ca3ad" fontSize="10">
                {Math.round((max * (4 - i)) / 4).toLocaleString('en-US')}
              </text>
            </g>
          ))}
          <path d={path + ` L${x1},${y1} L${x0},${y1} Z`} fill="url(#area)" />
          <path d={path} fill="none" stroke="#24ac86" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
          {pts.map((p, i) => (
            <rect
              key={i}
              x={p[0] - 6}
              y={15}
              width={Math.max(10, step)}
              height={157}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
          {hover !== null && (
            <g>
              <line x1={pts[hover][0]} x2={pts[hover][0]} y1="20" y2={y1} stroke="#24ac86" strokeDasharray="3 3" />
              <circle cx={pts[hover][0]} cy={pts[hover][1]} r="4" fill="#fff" stroke="#24ac86" strokeWidth="2" />
            </g>
          )}
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <text key={i} x={x0 + (i * (x1 - x0)) / 6} y="197" textAnchor="middle" fill="#9198a3" fontSize="10">
              {new Date(anchorMs + (i * rangeDays * 86400000) / 6).toLocaleDateString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
              })}
            </text>
          ))}
        </svg>
        {hover !== null && (
          <div className="chart-tooltip" style={{ left: Math.min(77, (hover / raw.length) * 90 + 5) + '%' }}>
            {new Date(anchorMs + hover * bucketMs).toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
            })}
            <strong>
              {raw[hover].toLocaleString('en-US')} {displayedMetric === 'requests' ? '次' : 'Tokens'}
            </strong>
          </div>
        )}
      </div>
    </section>
  )
}
