'use client'

import type { ReactNode } from 'react'
import { StaleBadge } from './States'

export function PageHeader({
  title,
  description,
  badge,
  stale = false,
  children,
}: {
  title: string
  description: string
  badge?: ReactNode
  stale?: boolean
  children?: ReactNode
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="heading-title">
          <h1>{title}</h1>
          {badge}
          {stale ? <StaleBadge /> : null}
        </div>
        <p>{description}</p>
      </div>
      <div className="page-actions">{children}</div>
    </div>
  )
}
