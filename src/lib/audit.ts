// Audit logging for the control plane.
//
// Every credential / key / session mutation writes an audit_events row.
// Two rules are non-negotiable here:
//   1. No secret ever reaches the database or the log stream. Metadata is run
//      through `redactSecrets` before insert.
//   2. Credential lifecycle audit is fail-closed: if the audit row cannot be
//      written, the operation is considered to have failed. Use
//      `safeLogAudit` only for non-security telemetry.

import { insertAuditEvent } from '@/lib/db/repositories'
import type { PoolClient } from 'pg'

export const AUDIT_ACTIONS = {
  credentialCreated: 'credential.created',
  credentialVerified: 'credential.verified',
  credentialUsed: 'credential.used',
  credentialRotated: 'credential.rotated',
  credentialDisabled: 'credential.disabled',
  credentialDecryptFailed: 'credential.decrypt_failed',
  apiKeyCreated: 'apikey.created',
  apiKeyVerified: 'apikey.verified',
  apiKeyVerifyFailed: 'apikey.verify_failed',
  apiKeyRevoked: 'apikey.revoked',
  sessionCreated: 'session.created',
  sessionRevoked: 'session.revoked',
  authzDenied: 'authz.denied',
  csrfRejected: 'csrf.rejected',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]

export interface AuditInput {
  actorUserId?: string | null
  tenantId?: string | null
  action: AuditAction | string
  targetType?: string
  targetId?: string
  metadata?: Record<string, unknown>
  ip?: string
  traceId?: string
  client?: PoolClient
}

const REDACTED = '[REDACTED]'

// Field names whose *value* is always a secret. Matching is exact-ish and
// deliberately does not include bare "key" (keyId / keyPrefix are safe and
// useful in audit).
const SECRET_FIELD =
  /^(secret|password|passwd|token|access[_-]?token|refresh[_-]?token|session[_-]?token|api[_-]?key|apikey|authorization|auth|cookie|credential[_-]?secret|private[_-]?key|client[_-]?secret|encrypted[_-]?data[_-]?key|dek|plaintext|hash|password[_-]?hash)$/i

// Inline secret shapes scrubbed out of otherwise-safe strings.
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-nx-[A-Za-z0-9_-]{8,}/g, // NexusAPI downstream keys
  /\bsk-[A-Za-z0-9_-]{16,}/g, // generic provider keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization headers
  /\bnx1\.[A-Za-z0-9+/=_-]{16,}/g, // NexusAPI envelope blobs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bv\d+:[0-9a-f]{16,}:[0-9a-f]{16,}:[0-9a-f]{8,}/g, // crypto.ts ciphertext
]

export function redactString(input: string): string {
  let out = input
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED)
  return out
}

/**
 * Deep-redact a metadata object. Not a substitute for never passing secrets —
 * it is a defence in depth for accidental leaks.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactSecrets(v, depth + 1))
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[k] = SECRET_FIELD.test(k) ? REDACTED : redactSecrets(v, depth + 1)
    }
    return out
  }
  return REDACTED
}

/**
 * Write an audit event. Throws if the write fails — callers performing a
 * security-relevant mutation must treat that as failure of the mutation.
 */
export async function logAudit(input: AuditInput): Promise<void> {
  const metadata = (redactSecrets(input.metadata ?? {}) as Record<string, unknown>) ?? {}
  // audit_events.tenant_id is nullable (platform/system events have no tenant).
  // The repository types the parameter as string, so null is passed through
  // explicitly rather than storing an empty-string tenant.
  const tenantId = (input.tenantId ?? null) as unknown as string
  await insertAuditEvent(
    tenantId,
    {
      actorUserId: input.actorUserId ?? undefined,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata,
      ip: input.ip,
      traceId: input.traceId,
    },
    input.client,
  )
}

/** Best-effort variant for non-security telemetry; never throws. */
export async function safeLogAudit(input: AuditInput): Promise<void> {
  try {
    await logAudit(input)
  } catch {
    // Intentionally swallowed: telemetry must not break the request path.
  }
}

/**
 * Convenience wrapper used by the auth modules. Keeps the redaction and
 * fail-closed behaviour in one place.
 */
export async function auditDenied(input: {
  actorUserId?: string | null
  tenantId?: string | null
  action: string
  targetType?: string
  targetId?: string
  reason: string
  ip?: string
  traceId?: string
}): Promise<void> {
  await safeLogAudit({
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    action: AUDIT_ACTIONS.authzDenied,
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: { deniedAction: input.action, reason: input.reason },
    ip: input.ip,
    traceId: input.traceId,
  })
}
