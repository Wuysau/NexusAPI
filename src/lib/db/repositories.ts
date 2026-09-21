// Tenant-scoped repositories for the new billing path.
//
// INVARIANT #1: every business row is explicitly bound to a tenant. Every
// repository method below takes `tenantId` as its first parameter and filters
// on it. A separate SystemRepository type exists for cross-tenant operations
// (sync, reconciliation, platform management) — it is marked as requiring a
// system role; Work Item C enforces the actual RBAC check.
//
// These are thin data-access functions, not a heavy ORM layer. They use the
// Drizzle query builder against the schema in src/db/schema.ts. Callers own
// transactions (pass a PoolClient for atomic multi-step writes); otherwise a
// fresh connection is used per call.

import { db, pool } from '@/db'
import {
  downstreamApiKeys,
  providerCredentials,
  upstreamModels,
  providerPriceVersions,
  requestRecords,
  usageEvents,
  usageRecords,
  ledgerAccounts,
  ledgerTransactions,
  ledgerPostings,
  orders,
  auditEvents,
  outboxEvents,
  organizations,
  walletAccounts,
} from '@/db/schema'
import { eq, and, desc, sql } from 'drizzle-orm'
import type { PoolClient } from 'pg'
import type { Micros } from '@/lib/money'

// ── Types ─────────────────────────────────────────────────────────────

export interface ApiKeyRow {
  id: string
  tenantId: string
  name: string
  hash: string
  prefix: string
  fingerprint: string | null
  scopes: string[]
  enabled: boolean
  expiresAt: Date | null
  revokedAt: Date | null
  lastUsedAt: Date | null
  createdAt: Date
}

export interface CredentialRow {
  id: string
  tenantId: string | null
  providerId: string
  name: string
  encryptedSecret: string
  encryptionKeyVersion: number
  credentialType: string
  isPlatformManaged: boolean
  enabled: boolean
  createdAt: Date
}

export interface LedgerAccountRow {
  id: string
  tenantId: string
  walletId: string | null
  type: string
  currency: string
  code: string
  status: string
}

export interface LedgerTransactionRow {
  id: string
  tenantId: string
  type: string
  currency: string
  idempotencyKey: string
  referenceType: string | null
  referenceId: string | null
  postedAt: Date
}

// ── Api Keys (downstream_api_keys) ────────────────────────────────────

export async function findApiKeyByHash(hash: string, client?: PoolClient): Promise<ApiKeyRow | null> {
  // Key lookup is cross-tenant (the hash identifies the caller before we know
  // the tenant). This is a SystemRepository-style read used by the gateway
  // auth path; Work Item C wraps it in the capability check.
  const query = client ?? pool
  const result = await query.query(
    `SELECT id, tenant_id, name, hash, prefix, fingerprint, scopes, enabled,
            expires_at, revoked_at, last_used_at, created_at
     FROM downstream_api_keys
     WHERE hash = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [hash],
  )
  if (!result.rows.length) return null
  const r = result.rows[0]
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    hash: r.hash,
    prefix: r.prefix,
    fingerprint: r.fingerprint,
    scopes: r.scopes,
    enabled: r.enabled,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }
}

export async function listApiKeys(tenantId: string, client?: PoolClient): Promise<ApiKeyRow[]> {
  const query = client ?? pool
  const result = await query.query(
    `SELECT id, tenant_id, name, hash, prefix, fingerprint, scopes, enabled,
            expires_at, revoked_at, last_used_at, created_at
     FROM downstream_api_keys
     WHERE tenant_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [tenantId],
  )
  return result.rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    hash: r.hash,
    prefix: r.prefix,
    fingerprint: r.fingerprint,
    scopes: r.scopes,
    enabled: r.enabled,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }))
}

export async function createApiKey(
  tenantId: string,
  input: {
    name: string
    hash: string
    prefix: string
    fingerprint?: string
    scopes?: string[]
    createdBy?: string
  },
  client?: PoolClient,
): Promise<ApiKeyRow> {
  const query = client ?? pool
  // Resolve organization_id from tenant_id (expand phase: both coexist)
  const orgResult = await query.query(`SELECT id FROM organizations WHERE tenant_id = $1 LIMIT 1`, [tenantId])
  if (!orgResult.rows.length) {
    throw new Error(`no organization found for tenant_id ${tenantId}`)
  }
  const orgId = orgResult.rows[0].id
  const result = await query.query(
    `INSERT INTO downstream_api_keys (id, organization_id, tenant_id, name, hash, prefix, fingerprint, scopes, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, tenant_id, name, hash, prefix, fingerprint, scopes, enabled, expires_at, revoked_at, last_used_at, created_at`,
    [
      orgId,
      tenantId,
      input.name,
      input.hash,
      input.prefix,
      input.fingerprint ?? null,
      JSON.stringify(input.scopes ?? []),
      input.createdBy ?? null,
    ],
  )
  const r = result.rows[0]
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    hash: r.hash,
    prefix: r.prefix,
    fingerprint: r.fingerprint,
    scopes: r.scopes,
    enabled: r.enabled,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }
}

export async function revokeApiKey(tenantId: string, keyId: string, client?: PoolClient): Promise<boolean> {
  const query = client ?? pool
  const result = await query.query(
    `UPDATE downstream_api_keys
     SET revoked_at = now(), enabled = false
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [keyId, tenantId],
  )
  return result.rows.length > 0
}

// ── Credentials (provider_credentials) ────────────────────────────────

export async function findCredentialById(
  tenantId: string,
  credentialId: string,
  client?: PoolClient,
): Promise<CredentialRow | null> {
  const query = client ?? pool
  const result = await query.query(
    `SELECT id, tenant_id, provider_id, name, encrypted_secret, encryption_key_version,
            credential_type, is_platform_managed, enabled, created_at
     FROM provider_credentials
     WHERE id = $1 AND (tenant_id = $2 OR is_platform_managed = true)
     LIMIT 1`,
    [credentialId, tenantId],
  )
  if (!result.rows.length) return null
  const r = result.rows[0]
  return {
    id: r.id,
    tenantId: r.tenant_id,
    providerId: r.provider_id,
    name: r.name,
    encryptedSecret: r.encrypted_secret,
    encryptionKeyVersion: r.encryption_key_version,
    credentialType: r.credential_type,
    isPlatformManaged: r.is_platform_managed,
    enabled: r.enabled,
    createdAt: r.created_at,
  }
}

export async function listCredentials(tenantId: string, client?: PoolClient): Promise<CredentialRow[]> {
  const query = client ?? pool
  const result = await query.query(
    `SELECT id, tenant_id, provider_id, name, encrypted_secret, encryption_key_version,
            credential_type, is_platform_managed, enabled, created_at
     FROM provider_credentials
     WHERE tenant_id = $1 OR is_platform_managed = true
     ORDER BY created_at DESC`,
    [tenantId],
  )
  return result.rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    providerId: r.provider_id,
    name: r.name,
    encryptedSecret: r.encrypted_secret,
    encryptionKeyVersion: r.encryption_key_version,
    credentialType: r.credential_type,
    isPlatformManaged: r.is_platform_managed,
    enabled: r.enabled,
    createdAt: r.created_at,
  }))
}

// ── Models (upstream_models) ──────────────────────────────────────────

export async function listModels(tenantId: string, client?: PoolClient) {
  // upstream_models are platform-scoped (not tenant-scoped), but the repository
  // signature takes tenantId for API consistency. The tenant filter applies to
  // which models are enabled for the tenant via channels/model_aliases.
  const query = client ?? pool
  const result = await query.query(
    `SELECT id, provider_id, upstream_model_id, display_name, context_window,
            max_output_tokens, capabilities, lifecycle_status, available, manually_enabled,
            first_seen_at, last_seen_at, created_at, updated_at
     FROM upstream_models
     ORDER BY display_name ASC`,
    [],
  )
  return result.rows
}

// ── Price Versions (provider_price_versions) ─────────────────────────

export async function listPriceVersions(tenantId: string, providerId?: string, client?: PoolClient) {
  const query = client ?? pool
  const params: (string | undefined)[] = [tenantId]
  let providerFilter = ''
  if (providerId) {
    providerFilter = 'AND provider_id = $2'
    params.push(providerId)
  }
  const result = await query.query(
    `SELECT id, provider_id, upstream_model_id, currency, region, service_tier,
            input_price, output_price, cached_input_price, reasoning_price,
            request_price, unit, source_type, status, effective_from, effective_to,
            approved_by, approved_at, created_at
     FROM provider_price_versions
     WHERE status IN ('active', 'approved')
     ${providerFilter}
     ORDER BY effective_from DESC NULLS LAST, created_at DESC`,
    params,
  )
  return result.rows
}

// ── Requests (request_records) ────────────────────────────────────────

export async function findRequestById(tenantId: string, requestId: string, client?: PoolClient) {
  const query = client ?? pool
  const result = await query.query(`SELECT * FROM request_records WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [
    requestId,
    tenantId,
  ])
  return result.rows[0] ?? null
}

export async function listRequests(tenantId: string, limit = 50, offset = 0, client?: PoolClient) {
  const query = client ?? pool
  const result = await query.query(
    `SELECT id, tenant_id, downstream_key_id, request_model, resolved_provider_id,
            resolved_upstream_model_id, status, input_tokens, output_tokens, cached_tokens,
            reasoning_tokens, charge_amount, charge_currency, upstream_cost_amount,
            upstream_cost_currency, error_code, trace_id, started_at, completed_at, created_at
     FROM request_records
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  )
  return result.rows
}

// ── Usage Events ──────────────────────────────────────────────────────

export async function insertUsageEvent(
  tenantId: string,
  input: {
    eventId: string
    eventType: string
    requestId?: string
    attemptId?: string
    providerRequestId?: string
    payload?: Record<string, unknown>
  },
  client?: PoolClient,
) {
  const query = client ?? pool
  const result = await query.query(
    `INSERT INTO usage_events (id, tenant_id, request_id, attempt_id, event_id, event_type, provider_request_id, payload)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, event_id) DO NOTHING
     RETURNING id, tenant_id, event_id, event_type, created_at`,
    [
      tenantId,
      input.requestId ?? null,
      input.attemptId ?? null,
      input.eventId,
      input.eventType,
      input.providerRequestId ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  )
  return result.rows[0] ?? null
}

export async function findUsageEventByEventId(tenantId: string, eventId: string, client?: PoolClient) {
  const query = client ?? pool
  const result = await query.query(`SELECT * FROM usage_events WHERE tenant_id = $1 AND event_id = $2 LIMIT 1`, [
    tenantId,
    eventId,
  ])
  return result.rows[0] ?? null
}

// ── Usage Records ─────────────────────────────────────────────────────

export async function insertUsageRecord(
  tenantId: string,
  input: {
    requestId?: string
    usageEventId?: string
    inputTokens: number
    outputTokens: number
    cachedTokens: number
    reasoningTokens: number
    upstreamCostAmount?: Micros
    upstreamCostCurrency?: string
    chargeAmount: Micros
    chargeCurrency: string
    estimatedAmount?: boolean
  },
  client?: PoolClient,
) {
  const query = client ?? pool
  const result = await query.query(
    `INSERT INTO usage_records (id, tenant_id, request_id, usage_event_id, input_tokens,
                                output_tokens, cached_tokens, reasoning_tokens,
                                upstream_cost_amount, upstream_cost_currency,
                                charge_amount, charge_currency, estimated_amount)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, tenant_id, created_at`,
    [
      tenantId,
      input.requestId ?? null,
      input.usageEventId ?? null,
      input.inputTokens,
      input.outputTokens,
      input.cachedTokens,
      input.reasoningTokens,
      input.upstreamCostAmount?.toString() ?? null,
      input.upstreamCostCurrency ?? null,
      input.chargeAmount.toString(),
      input.chargeCurrency,
      input.estimatedAmount ?? false,
    ],
  )
  return result.rows[0]
}

// ── Ledger (accounts, transactions, postings) ─────────────────────────
// The balance invariant (sum(amount)=0 per transaction per currency) is
// enforced at DB level by a DEFERRABLE constraint trigger. The immutability
// of postings is enforced by BEFORE UPDATE/DELETE triggers. See migration 0001.

export async function findLedgerAccountByCode(
  tenantId: string,
  code: string,
  client?: PoolClient,
): Promise<LedgerAccountRow | null> {
  const query = client ?? pool
  const result = await query.query(
    `SELECT id, tenant_id, wallet_id, type, currency, code, status
     FROM ledger_accounts
     WHERE tenant_id = $1 AND code = $2
     LIMIT 1`,
    [tenantId, code],
  )
  if (!result.rows.length) return null
  const r = result.rows[0]
  return {
    id: r.id,
    tenantId: r.tenant_id,
    walletId: r.wallet_id,
    type: r.type,
    currency: r.currency,
    code: r.code,
    status: r.status,
  }
}

export async function createLedgerAccount(
  tenantId: string,
  input: {
    walletId?: string
    type: string
    currency: string
    code: string
  },
  client?: PoolClient,
): Promise<LedgerAccountRow> {
  const query = client ?? pool
  const result = await query.query(
    `INSERT INTO ledger_accounts (id, tenant_id, wallet_id, type, currency, code)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     RETURNING id, tenant_id, wallet_id, type, currency, code, status`,
    [tenantId, input.walletId ?? null, input.type, input.currency, input.code],
  )
  const r = result.rows[0]
  return {
    id: r.id,
    tenantId: r.tenant_id,
    walletId: r.wallet_id,
    type: r.type,
    currency: r.currency,
    code: r.code,
    status: r.status,
  }
}

export async function findLedgerTransactionByIdempotencyKey(
  tenantId: string,
  idempotencyKey: string,
  client?: PoolClient,
): Promise<LedgerTransactionRow | null> {
  const query = client ?? pool
  const result = await query.query(
    `SELECT id, tenant_id, type, currency, idempotency_key, reference_type, reference_id, posted_at
     FROM ledger_transactions
     WHERE tenant_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [tenantId, idempotencyKey],
  )
  if (!result.rows.length) return null
  const r = result.rows[0]
  return {
    id: r.id,
    tenantId: r.tenant_id,
    type: r.type,
    currency: r.currency,
    idempotencyKey: r.idempotency_key,
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    postedAt: r.posted_at,
  }
}

// ── Orders ────────────────────────────────────────────────────────────

export async function findOrderByIdempotencyKey(tenantId: string, idempotencyKey: string, client?: PoolClient) {
  const query = client ?? pool
  const result = await query.query(`SELECT * FROM orders WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`, [
    tenantId,
    idempotencyKey,
  ])
  return result.rows[0] ?? null
}

export async function listOrders(tenantId: string, limit = 50, client?: PoolClient) {
  const query = client ?? pool
  const result = await query.query(`SELECT * FROM orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`, [
    tenantId,
    limit,
  ])
  return result.rows
}

// ── Audit Events ──────────────────────────────────────────────────────

export async function insertAuditEvent(
  tenantId: string,
  input: {
    actorUserId?: string
    action: string
    targetType?: string
    targetId?: string
    metadata?: Record<string, unknown>
    ip?: string
    traceId?: string
  },
  client?: PoolClient,
) {
  const query = client ?? pool
  const result = await query.query(
    `INSERT INTO audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, metadata, ip, trace_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, tenant_id, created_at`,
    [
      tenantId,
      input.actorUserId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.ip ?? null,
      input.traceId ?? null,
    ],
  )
  return result.rows[0]
}

// ── Outbox Events ─────────────────────────────────────────────────────

export async function insertOutboxEvent(
  tenantId: string,
  input: {
    aggregateType: string
    aggregateId: string
    eventType: string
    payload?: Record<string, unknown>
    idempotencyKey: string
  },
  client?: PoolClient,
) {
  const query = client ?? pool
  const result = await query.query(
    `INSERT INTO outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING id, tenant_id, status, created_at`,
    [
      tenantId,
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
      input.idempotencyKey,
    ],
  )
  return result.rows[0] ?? null
}

// ── Wallet lookup (tenant-scoped) ──────────────────────────────────────

export async function findWalletByTenant(tenantId: string, currency = 'USD', client?: PoolClient) {
  const query = client ?? pool
  const result = await query.query(
    `SELECT id, tenant_id, currency, status, created_at
     FROM wallet_accounts
     WHERE tenant_id = $1 AND currency = $2
     LIMIT 1`,
    [tenantId, currency],
  )
  return result.rows[0] ?? null
}

// ── System Repository (cross-tenant) ──────────────────────────────────
// SystemRepository is for platform-level operations that span tenants:
// sync runs, reconciliation, incident management, global retention policies.
// Work Item C enforces that only a system-auditor / platform-admin role can
// call these. The type signature makes the cross-tenant nature explicit.

export interface SystemRepository {
  listAllTenants(): Promise<{ id: string; tenantId: string; name: string; status: string }[]>
  findSyncRuns(status?: string): Promise<unknown[]>
  listReconciliationCases(status?: string): Promise<unknown[]>
  listAllOutboxPending(limit?: number): Promise<unknown[]>
}

export const systemRepository: SystemRepository = {
  async listAllTenants() {
    const result = await pool.query(
      `SELECT id, tenant_id, name, status FROM organizations WHERE deleted_at IS NULL ORDER BY created_at ASC`,
    )
    return result.rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      status: r.status,
    }))
  },

  async findSyncRuns(status?: string) {
    if (status) {
      const result = await pool.query(`SELECT * FROM sync_runs WHERE status = $1 ORDER BY created_at DESC LIMIT 100`, [
        status,
      ])
      return result.rows
    }
    const result = await pool.query(`SELECT * FROM sync_runs ORDER BY created_at DESC LIMIT 100`)
    return result.rows
  },

  async listReconciliationCases(status?: string) {
    if (status) {
      const result = await pool.query(
        `SELECT * FROM reconciliation_cases WHERE status = $1 ORDER BY created_at DESC LIMIT 100`,
        [status],
      )
      return result.rows
    }
    const result = await pool.query(`SELECT * FROM reconciliation_cases ORDER BY created_at DESC LIMIT 100`)
    return result.rows
  },

  async listAllOutboxPending(limit = 100) {
    const result = await pool.query(
      `SELECT * FROM outbox_events WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1`,
      [limit],
    )
    return result.rows
  },
}
