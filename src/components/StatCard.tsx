'use client'

import type { ReactNode } from 'react'

export function StatCard({
  label,
  value,
  unit,
  note,
  icon,
  color = '#29ad8a',
  empty = false,
}: {
  label: string
  value: string
  unit?: string
  note?: string
  icon: ReactNode
  color?: string
  variant?: number
  empty?: boolean
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        <span className="stat-icon" style={{ color, background: color + '12' }}>
          {icon}
        </span>
      </div>
      <div className="stat-value">
        {value}
        {unit && <span>{unit}</span>}
      </div>
      <div className="stat-bottom">
        <span className="stat-trend">{empty ? '暂无数据' : (note ?? '—')}</span>
      </div>
    </div>
  )
}
