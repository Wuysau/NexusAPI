import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'

const dependencies = vi.hoisted(() => ({
  loadRequestRecord: vi.fn(),
  getReservedAmount: vi.fn(),
  releaseReservation: vi.fn(),
  logAudit: vi.fn(),
}))
vi.mock('@/db', () => ({ pool: {} }))
vi.mock('@/lib/audit', () => ({ logAudit: dependencies.logAudit }))
vi.mock('./pipeline', () => ({
  loadRequestRecord: dependencies.loadRequestRecord,
  getReservedAmount: dependencies.getReservedAmount,
  releaseReservation: dependencies.releaseReservation,
}))
vi.mock('./recompute', () => ({ recomputeRequestCharge: vi.fn() }))

import { resolveReconciliationCase } from './reconcile'

beforeEach(() => {
  vi.clearAllMocks()
  dependencies.loadRequestRecord.mockResolvedValue({
    reservation_released: false,
    reservation_amount: '100',
    charge_currency: 'USD',
  })
  dependencies.getReservedAmount.mockResolvedValue(100n)
  dependencies.releaseReservation.mockResolvedValue({ amount: 100n })
})

const input = (tenantId: string) => ({
  tenantId,
  caseId: 'case-b',
  status: 'resolved' as const,
  resolution: 'operator verified upstream failure',
  resolvedBy: 'operator',
  releaseHold: true,
})

/** Query double models the tenant filter and row lock, not billing arithmetic. */
function fixture() {
  const row = {
    id: 'case-b',
    tenant_id: 'tenant-b',
    request_id: 'request-b',
    status: 'open',
    reason: 'unknown_completion',
    expected_amount: null,
    actual_amount: null,
    currency: 'USD',
    resolution: null,
  }
  const statements: Array<{ sql: string; values: unknown[] }> = []
  let lock = Promise.resolve()
  function client() {
    let unlock: (() => void) | undefined
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values })
      if (/SELECT[\s\S]*FROM reconciliation_cases/i.test(sql)) {
        const tenantParameter = /tenant_id\s*=\s*\$(\d+)/i.exec(sql)
        if (tenantParameter && values[Number(tenantParameter[1]) - 1] !== row.tenant_id) return { rows: [] }
        if (/FOR UPDATE/i.test(sql)) {
          const previous = lock
          lock = new Promise<void>((resolve) => {
            unlock = resolve
          })
          await previous
        }
        return { rows: [{ ...row }] }
      }
      if (/UPDATE reconciliation_cases/i.test(sql)) {
        const tenantParameter = /tenant_id\s*=\s*\$(\d+)/i.exec(sql)
        if (!tenantParameter || values[Number(tenantParameter[1]) - 1] !== row.tenant_id)
          throw new Error('unscoped case mutation')
        row.status = 'resolved'
      }
      return { rows: [], rowCount: 1 }
    })
    return { db: { query } as unknown as PoolClient, commit: () => unlock?.() }
  }
  return { row, statements, client }
}

describe('explicit reconciliation tenant scope', () => {
  it('rejects another tenant case before any hold release or mutation', async () => {
    const db = fixture()
    const transaction = db.client()
    await expect(resolveReconciliationCase(transaction.db, input('tenant-a'))).rejects.toThrow(/not found/i)
    expect(dependencies.loadRequestRecord).not.toHaveBeenCalled()
    expect(dependencies.releaseReservation).not.toHaveBeenCalled()
    expect(dependencies.logAudit).not.toHaveBeenCalled()
    expect(db.statements).toHaveLength(1)
    expect(db.row.status).toBe('open')
  })

  it('requires runtime tenant scope rather than inferring it from the case', async () => {
    const db = fixture()
    await expect(resolveReconciliationCase(db.client().db, input(''))).rejects.toThrow(/tenant/i)
    expect(db.statements).toHaveLength(0)
    expect(dependencies.releaseReservation).not.toHaveBeenCalled()
  })

  it('locks the scoped case before releasing a hold and scopes the case update', async () => {
    const db = fixture()
    const transaction = db.client()
    const result = await resolveReconciliationCase(transaction.db, input('tenant-b'))
    transaction.commit()
    expect(result).toEqual({ resolved: true, reservationReleased: true })
    expect(db.statements[0].sql).toMatch(/tenant_id\s*=\s*\$\d[\s\S]*FOR UPDATE/i)
    expect(dependencies.loadRequestRecord).toHaveBeenCalledWith(transaction.db, 'tenant-b', 'request-b')
    expect(dependencies.logAudit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-b' }))
    expect(db.statements.find((statement) => /UPDATE reconciliation_cases/i.test(statement.sql))?.sql).toMatch(
      /tenant_id\s*=\s*\$\d/i,
    )
  })

  it('serializes two resolutions so only the first attempts a hold release', async () => {
    const db = fixture()
    const run = async () => {
      const transaction = db.client()
      try {
        return await resolveReconciliationCase(transaction.db, input('tenant-b'))
      } finally {
        transaction.commit()
      }
    }
    const results = await Promise.all([run(), run()])
    expect(results).toEqual([
      { resolved: true, reservationReleased: true },
      { resolved: false, reservationReleased: false },
    ])
    expect(dependencies.releaseReservation).toHaveBeenCalledTimes(1)
    expect(dependencies.logAudit).toHaveBeenCalledTimes(1)
  })
})
