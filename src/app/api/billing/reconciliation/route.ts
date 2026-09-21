// Reconciliation cases: requests whose terminal state was not known, or whose
// settled amount disagreed with a recomputation. An operator must close these
// by hand — the system never guesses an outcome (INVARIANT #10, F5).
//
// Closing a case is a money-affecting action: `billing:manage` + fresh session,
// and the compensation goes through the normal idempotent ledger path in
// `resolveReconciliationCase`.

import { pool } from '@/db'
import { resolveReconciliationCase } from '@/lib/billing/reconcile'
import { fromMicros } from '@/lib/money'
import {
  apiError,
  jsonOk,
  readJsonBody,
  requireContext,
  requireHighRiskContext,
  routeError,
} from '../../_lib/control-plane'

export const dynamic = 'force-dynamic'

interface CaseRow {
  id: string
  request_id: string | null
  status: string
  reason: string
  expected_amount: string | null
  actual_amount: string | null
  currency: string | null
  resolution: string | null
  resolved_by: string | null
  resolved_at: Date | null
  created_at: Date
  updated_at: Date
}

export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req, 'billing:read')
    const result = await pool.query<CaseRow>(
      `SELECT id, request_id, status, reason, expected_amount, actual_amount, currency,
              resolution, resolved_by, resolved_at, created_at, updated_at
         FROM reconciliation_cases
        WHERE tenant_id = $1
        ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END, created_at DESC
        LIMIT 200`,
      [ctx.tenantId],
    )
    return jsonOk({
      cases: result.rows.map((row) => ({
        id: row.id,
        requestId: row.request_id,
        status: row.status,
        reason: row.reason,
        expectedAmount: row.expected_amount === null ? null : fromMicros(BigInt(row.expected_amount)),
        actualAmount: row.actual_amount === null ? null : fromMicros(BigInt(row.actual_amount)),
        currency: row.currency,
        resolution: row.resolution,
        resolvedBy: row.resolved_by,
        resolvedAt: row.resolved_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
    })
  } catch (error) {
    return routeError(error)
  }
}

interface ResolveBody {
  caseId?: unknown
  status?: unknown
  resolution?: unknown
  releaseHold?: unknown
}

export async function POST(req: Request) {
  try {
    const ctx = await requireHighRiskContext(req, 'billing:manage')
    const body = await readJsonBody<ResolveBody>(req)
    const caseId = typeof body?.caseId === 'string' ? body.caseId : ''
    if (!caseId) return apiError(400, 'invalid_request', '缺少 caseId')
    if (body?.status !== 'resolved' && body?.status !== 'unresolved') {
      return apiError(400, 'invalid_request', 'status 必须为 resolved 或 unresolved')
    }
    const resolution = typeof body?.resolution === 'string' ? body.resolution.trim().slice(0, 500) : ''
    if (!resolution) return apiError(400, 'invalid_request', '请填写处理说明')

    const owned = await pool.query('SELECT id FROM reconciliation_cases WHERE id = $1 AND tenant_id = $2', [
      caseId,
      ctx.tenantId,
    ])
    if (!owned.rowCount) return apiError(404, 'not_found', '对账工单不存在')

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await resolveReconciliationCase(client, {
        tenantId: ctx.tenantId,
        caseId,
        status: body.status,
        resolution,
        resolvedBy: ctx.principal.userId ?? 'unknown',
        releaseHold: body?.releaseHold === true,
      })
      await client.query('COMMIT')
      return jsonOk({ caseId, ...result })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    return routeError(error)
  }
}
