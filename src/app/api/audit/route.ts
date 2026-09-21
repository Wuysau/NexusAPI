// Audit trail read + export.
//
// Audit rows are append-only (no capability mutates them). Metadata was already
// redacted at write time by src/lib/audit.ts; this route re-redacts on read as
// defence in depth. Roles without `system:cross-tenant` only ever see their own
// tenant. Finance/support-style roles (billing) receive redacted metadata with
// the acting user id withheld; owner/admin/system-auditor see the full record.

import { NextResponse } from 'next/server'
import { pool } from '@/db'
import { redactSecrets } from '@/lib/audit'
import { hasCapability } from '@/lib/auth/capabilities'
import { jsonOk, requireContext, routeError } from '../_lib/control-plane'

export const dynamic = 'force-dynamic'

interface AuditRow {
  id: string
  actor_user_id: string | null
  tenant_id: string | null
  action: string
  target_type: string | null
  target_id: string | null
  metadata: Record<string, unknown>
  ip: string | null
  trace_id: string | null
  created_at: Date
}

const MAX_LIMIT = 500

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'audit:read')
    const url = new URL(req.url)
    const crossTenant = hasCapability(ctx.membership.role, 'system:cross-tenant')
    const privileged = hasCapability(ctx.membership.role, 'audit:export')

    const conditions: string[] = []
    const values: unknown[] = []
    if (!crossTenant) {
      values.push(ctx.tenantId)
      conditions.push(`tenant_id = $${values.length}`)
    }
    const action = url.searchParams.get('action')?.trim()
    if (action) {
      values.push(action)
      conditions.push(`action = $${values.length}`)
    }
    const from = url.searchParams.get('from')
    if (from && !Number.isNaN(new Date(from).getTime())) {
      values.push(new Date(from))
      conditions.push(`created_at >= $${values.length}`)
    }
    const to = url.searchParams.get('to')
    if (to && !Number.isNaN(new Date(to).getTime())) {
      values.push(new Date(to))
      conditions.push(`created_at <= $${values.length}`)
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100))
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = await pool.query<AuditRow>(
      `SELECT id, actor_user_id, tenant_id, action, target_type, target_id, metadata, ip, trace_id, created_at
         FROM audit_events ${where}
        ORDER BY created_at DESC
        LIMIT ${limit}`,
      values,
    )

    const serialize = (row: AuditRow) => ({
      id: row.id,
      actorUserId: privileged ? row.actor_user_id : null,
      tenantId: crossTenant ? row.tenant_id : undefined,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: redactSecrets(row.metadata ?? {}) as Record<string, unknown>,
      ip: privileged ? row.ip : null,
      traceId: row.trace_id,
      createdAt: row.created_at.toISOString(),
      redacted: !privileged,
    })

    if (url.searchParams.get('format') === 'csv') {
      // Export additionally requires `audit:export` (owner/admin/system-auditor).
      await requireContext(req, 'audit:export')
      const header = [
        'id',
        'created_at',
        'actor_user_id',
        'tenant_id',
        'action',
        'target_type',
        'target_id',
        'metadata',
        'ip',
        'trace_id',
      ].join(',')
      const lines = rows.rows.map((row) =>
        [
          row.id,
          row.created_at.toISOString(),
          row.actor_user_id,
          row.tenant_id,
          row.action,
          row.target_type,
          row.target_id,
          JSON.stringify(redactSecrets(row.metadata ?? {})),
          row.ip,
          row.trace_id,
        ]
          .map(csvCell)
          .join(','),
      )
      const csv = '﻿' + [header, ...lines].join('\n')
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="nexus-audit.csv"',
          'cache-control': 'no-store',
        },
      })
    }

    return jsonOk({
      events: rows.rows.map(serialize),
      // Billing-role callers get a redacted view; surface that to the UI so it
      // can render the "metadata redacted for your role" notice honestly.
      redacted: !privileged,
      limit,
    })
  } catch (error) {
    return routeError(error)
  }
}
