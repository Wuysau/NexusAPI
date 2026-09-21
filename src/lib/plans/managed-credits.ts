// Managed-credit enablement gate (ADR-0004).
//
// BYOK is the default commercial mode. Selling platform-managed credits is a
// separately controlled capability that creates funds-handling, tax and
// supplier-contract obligations, so it is OFF unless ALL of the following hold:
//
//   1. the global `managed_credits` feature flag is enabled (default false —
//      a missing row means disabled), AND
//   2. the tenant has a tenant_compliance record whose contract, payment, tax
//      and region checks are each `approved`.
//
// Anything else — missing flag, missing compliance row, any non-approved check —
// denies managed-credit checkout with 403. There is intentionally no admin
// bypass and no "test mode" that silently enables it.

import { pool } from '@/db'
import type { PoolClient } from 'pg'
import type { Queryable } from '@/lib/billing/pipeline'

export const MANAGED_CREDITS_FLAG = 'managed_credits'

export type ComplianceField = 'contract_status' | 'payment_status' | 'tax_status' | 'region_status'

export const COMPLIANCE_FIELDS: readonly ComplianceField[] = [
  'contract_status',
  'payment_status',
  'tax_status',
  'region_status',
]

export class ManagedCreditsError extends Error {
  readonly status = 403
  readonly code = 'managed_credits_not_enabled'

  constructor(
    message: string,
    public readonly reasons: string[] = [],
  ) {
    super(message)
    this.name = 'ManagedCreditsError'
  }
}

export interface ManagedCreditsStatus {
  enabled: boolean
  flagEnabled: boolean
  complianceApproved: boolean
  reasons: string[]
}

/**
 * Evaluate the managed-credit gate without throwing. A missing feature_flags
 * row and a missing tenant_compliance row both mean disabled.
 */
export async function managedCreditsStatus(tenantId: string, client?: PoolClient): Promise<ManagedCreditsStatus> {
  const query: Queryable = client ?? pool
  const reasons: string[] = []

  const flag = await query.query<{ enabled: boolean }>(`SELECT enabled FROM feature_flags WHERE key = $1 LIMIT 1`, [
    MANAGED_CREDITS_FLAG,
  ])
  const flagEnabled = flag.rows[0]?.enabled === true
  if (!flagEnabled) reasons.push('feature_flag_disabled')

  const compliance = await query.query<Record<ComplianceField, string>>(
    `SELECT contract_status, payment_status, tax_status, region_status
       FROM tenant_compliance WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  )
  const row = compliance.rows[0]
  let complianceApproved = false
  if (!row) {
    reasons.push('compliance_record_missing')
  } else {
    const rejected = COMPLIANCE_FIELDS.filter((f) => row[f] !== 'approved')
    complianceApproved = rejected.length === 0
    for (const f of rejected) reasons.push(`${f}:${row[f]}`)
  }

  return {
    enabled: flagEnabled && complianceApproved,
    flagEnabled,
    complianceApproved,
    reasons,
  }
}

/** Fail-closed guard: throws ManagedCreditsError (403) unless fully enabled. */
export async function assertManagedCreditsEnabled(tenantId: string, client?: PoolClient): Promise<void> {
  const status = await managedCreditsStatus(tenantId, client)
  if (!status.enabled) {
    throw new ManagedCreditsError('Managed credits are not enabled for this tenant.', status.reasons)
  }
}
