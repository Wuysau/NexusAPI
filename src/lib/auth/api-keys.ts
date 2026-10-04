// Downstream API key lifecycle (the sk-nx-* keys customers use against the
// gateway).
//
// Rules:
//   - The plaintext key is shown to the caller exactly once. Only
//     sha256(key) is persisted (downstream_api_keys.hash).
//   - Verification is a hash lookup + constant-time compare, then a check on
//     enabled / revoked_at / expires_at / scope. No cache: revocation is
//     effective on the next request.
//   - Revocation also bumps the in-process config-snapshot epoch and writes an
//     outbox event so gateway instances can invalidate their snapshots
//     (revocation propagation).
//   - The presented key never appears in an audit row, log or error message.

import { pool } from '@/db'
import type { PoolClient } from 'pg'
import { constantTimeEqual, newApiKey, sha256hex } from '@/lib/crypto'
import { createApiKey, findApiKeyByHash, revokeApiKey, insertOutboxEvent } from '@/lib/db/repositories'
import type { ApiKeyRow } from '@/lib/db/repositories'
import { logAudit, safeLogAudit, AUDIT_ACTIONS } from '@/lib/audit'

export const API_KEY_PREFIX = 'sk-nx-'

/** Scopes a downstream key may hold. `*` grants everything. */
export const API_KEY_SCOPES = [
  '*',
  'models:read',
  'chat:write',
  'embeddings:write',
  'images:write',
  'audio:write',
  'usage:read',
] as const

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export type ApiKeyErrorCode = 'invalid_name' | 'invalid_scope' | 'invalid_expiry' | 'key_not_found'

export class ApiKeyError extends Error {
  readonly code: ApiKeyErrorCode
  readonly status: number

  constructor(code: ApiKeyErrorCode, message: string) {
    super(message)
    this.name = 'ApiKeyError'
    this.code = code
    this.status = code === 'key_not_found' ? 404 : 400
  }
}

export type KeyVerifyFailureReason = 'malformed' | 'not_found' | 'revoked' | 'expired' | 'disabled' | 'scope_denied'

export type KeyVerifyResult = { ok: true; key: ApiKeyRow } | { ok: false; reason: KeyVerifyFailureReason }

export interface CreateDownstreamKeyInput {
  tenantId: string
  name: string
  /** Optional project binding already authorized by the caller. */
  projectId?: string | null
  scopes?: readonly string[]
  expiresAt?: Date | null
  actorUserId?: string
  ip?: string
  traceId?: string
}

export interface VerifyDownstreamKeyOptions {
  requiredScope?: string
  ip?: string
  traceId?: string
  /** Update last_used_at on success (default true). */
  touch?: boolean
}

export interface RevokeDownstreamKeyInput {
  tenantId: string
  keyId: string
  actorUserId?: string
  ip?: string
  traceId?: string
}

// ── Scope handling ────────────────────────────────────────────────────

export function isKnownScope(scope: string): boolean {
  return (API_KEY_SCOPES as readonly string[]).includes(scope)
}

/**
 * Does a granted scope list satisfy `required`? Supports exact match, `*`,
 * and prefix wildcards such as `chat:*`.
 */
export function scopeMatches(granted: readonly string[], required?: string | null): boolean {
  if (!required) return true
  if (!granted.length) return false
  if (granted.includes('*')) return true
  for (const g of granted) {
    if (g === required) return true
    if (g.endsWith(':*') && required.startsWith(g.slice(0, -1))) return true
  }
  return false
}

// ── Revocation propagation ────────────────────────────────────────────
// The gateway keeps a signed config/model snapshot. Key revocation is a
// control-plane event that must invalidate it. We expose a monotonically
// increasing epoch plus a listener hook; Work Item E owns the gateway-side
// consumption and the outbox consumer.

let revocationEpoch = 0
const invalidationListeners = new Set<(keyId: string, epoch: number) => void>()

export function getRevocationEpoch(): number {
  return revocationEpoch
}

export function onDownstreamKeyInvalidated(listener: (keyId: string, epoch: number) => void): () => void {
  invalidationListeners.add(listener)
  return () => invalidationListeners.delete(listener)
}

/** Bump the snapshot epoch and notify listeners. Returns the new epoch. */
export function invalidateDownstreamKeyCache(keyId = '*'): number {
  revocationEpoch += 1
  for (const listener of invalidationListeners) {
    try {
      listener(keyId, revocationEpoch)
    } catch {
      // A broken listener must never block revocation.
    }
  }
  return revocationEpoch
}

/** Test-only reset. */
export function __resetRevocationStateForTests(): void {
  revocationEpoch = 0
  invalidationListeners.clear()
}

// ── Create ────────────────────────────────────────────────────────────

export async function createDownstreamKey(
  input: CreateDownstreamKeyInput,
): Promise<{ plaintext: string; key: ApiKeyRow }> {
  const name = input.name?.trim()
  if (!name) throw new ApiKeyError('invalid_name', 'key name is required')

  const scopes = Array.from(new Set(input.scopes ?? ['chat:write']))
  for (const scope of scopes) {
    if (!isKnownScope(scope)) throw new ApiKeyError('invalid_scope', `unknown scope: ${scope}`)
  }

  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new ApiKeyError('invalid_expiry', 'expiresAt must be in the future')
  }

  // Plaintext is returned once by this function; it is never persisted.
  const plaintext = newApiKey(API_KEY_PREFIX)
  const hash = sha256hex(plaintext)
  // Short, non-secret fingerprint for display / support lookups.
  const fingerprint = sha256hex(plaintext).slice(0, 16)

  const client = await pool.connect()
  let key: ApiKeyRow
  try {
    await client.query('BEGIN')
    key = await createApiKey(
      input.tenantId,
      {
        name,
        hash,
        prefix: API_KEY_PREFIX,
        fingerprint,
        scopes,
        createdBy: input.actorUserId,
      },
      client,
    )
    if (input.projectId) {
      await client.query(`UPDATE downstream_api_keys SET project_id = $1 WHERE id = $2 AND tenant_id = $3`, [
        input.projectId,
        key.id,
        input.tenantId,
      ])
    }
    if (input.expiresAt) {
      await client.query(`UPDATE downstream_api_keys SET expires_at = $1 WHERE id = $2 AND tenant_id = $3`, [
        input.expiresAt,
        key.id,
        input.tenantId,
      ])
    }
    // Scope, expiry and mandatory audit become visible together.
    await logAudit({
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      action: AUDIT_ACTIONS.apiKeyCreated,
      targetType: 'downstream_api_key',
      targetId: key.id,
      metadata: {
        name,
        scopes,
        prefix: API_KEY_PREFIX,
        fingerprint,
        expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
      },
      ip: input.ip,
      traceId: input.traceId,
      client,
    })
    await client.query('COMMIT')
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The original error is the one worth reporting.
    }
    throw err
  } finally {
    client.release()
  }

  key.expiresAt = input.expiresAt ?? null

  return { plaintext, key }
}

// ── Verify ────────────────────────────────────────────────────────────

export async function verifyDownstreamKey(
  presented: string | null | undefined,
  opts: VerifyDownstreamKeyOptions = {},
): Promise<KeyVerifyResult> {
  const failure = async (reason: KeyVerifyFailureReason): Promise<KeyVerifyResult> => {
    // Never record any part of the presented key.
    await safeLogAudit({
      tenantId: null,
      action: AUDIT_ACTIONS.apiKeyVerifyFailed,
      targetType: 'downstream_api_key',
      metadata: { reason, requiredScope: opts.requiredScope ?? null },
      ip: opts.ip,
      traceId: opts.traceId,
    })
    return { ok: false, reason }
  }

  if (!presented || typeof presented !== 'string' || !presented.startsWith(API_KEY_PREFIX) || presented.length < 24) {
    return failure('malformed')
  }

  const hash = sha256hex(presented)
  const key = await findApiKeyByHash(hash)
  if (!key) return failure('not_found')

  // Defence in depth against timing leaks in the index lookup.
  if (!constantTimeEqual(key.hash, hash)) return failure('not_found')

  if (key.revokedAt) return failure('revoked')
  if (!key.enabled) return failure('disabled')
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return failure('expired')
  if (!scopeMatches(key.scopes ?? [], opts.requiredScope)) return failure('scope_denied')

  if (opts.touch !== false) {
    try {
      await pool.query(`UPDATE downstream_api_keys SET last_used_at = now() WHERE id = $1 AND tenant_id = $2`, [
        key.id,
        key.tenantId,
      ])
    } catch {
      // Best-effort bookkeeping; not a security decision.
    }
  }

  await safeLogAudit({
    tenantId: key.tenantId,
    action: AUDIT_ACTIONS.apiKeyVerified,
    targetType: 'downstream_api_key',
    targetId: key.id,
    metadata: { requiredScope: opts.requiredScope ?? null, scopeGranted: opts.requiredScope ?? null },
    ip: opts.ip,
    traceId: opts.traceId,
  })

  return { ok: true, key }
}

// ── Revoke ────────────────────────────────────────────────────────────

export async function revokeDownstreamKey(
  input: RevokeDownstreamKeyInput,
  authorize?: (client: PoolClient) => Promise<void>,
): Promise<boolean> {
  let revoked: boolean
  if (authorize) {
    // A trusted Control Plane guard and revoke share the same transaction/client.
    const client = await pool.connect()
    let discardClient = false
    try {
      await client.query('BEGIN')
      await authorize(client)
      revoked = await revokeApiKey(input.tenantId, input.keyId, client)
      await client.query('COMMIT')
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        discardClient = true
      }
      throw error
    } finally {
      client.release(discardClient)
    }
  } else {
    revoked = await revokeApiKey(input.tenantId, input.keyId)
  }
  if (!revoked) return false

  // Propagate to gateway snapshots. The outbox row is written after the
  // revoke commits; the epoch bump is synchronous and in-process.
  const epoch = invalidateDownstreamKeyCache(input.keyId)
  try {
    await insertOutboxEvent(input.tenantId, {
      aggregateType: 'downstream_api_key',
      aggregateId: input.keyId,
      eventType: 'api_key.revoked',
      payload: { keyId: input.keyId, revocationEpoch: epoch },
      idempotencyKey: `downstream_api_key.revoked:${input.keyId}`,
    })
  } catch {
    // The revoke itself is already durable; outbox retry is a worker concern.
  }

  await safeLogAudit({
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    action: AUDIT_ACTIONS.apiKeyRevoked,
    targetType: 'downstream_api_key',
    targetId: input.keyId,
    metadata: { revocationEpoch: epoch },
    ip: input.ip,
    traceId: input.traceId,
  })

  return true
}

/** List keys for a tenant. Re-exported so routes do not import the repo directly. */
export { listApiKeys } from '@/lib/db/repositories'
