// Redaction rules for the observability layer.
//
// The logger and trace exporter both run every field through this allowlist
// before emitting. The rule is deny-by-default: a field not on the allowlist is
// never written, and a denylisted field is always replaced with [REDACTED]
// even if its key happens to match an allowlist entry (defence in depth).
//
// This is the transport-level enforcement of INVARIANT #7 (no prompt, no
// completion, no credential, no upstream body in logs/traces). The application
// must still avoid passing secrets in the first place; this is the backstop.

/**
 * Fields that may appear in a structured log entry. Anything not in this set is
 * dropped before the line is written.
 */
export const LOG_FIELD_ALLOWLIST = [
  'level',
  'msg',
  'time',
  'request_id',
  'trace_id',
  'tenant_id_hash',
  'attempt_id',
  'duration_ms',
  'service',
  'version',
  'env',
  'method',
  'path',
  'status',
  'outcome',
  'error_kind',
  'provider',
  'model',
  'channel_id',
  'worker_id',
  'batch_id',
  'event_id',
  'aggregate_id',
  'disposition',
  'latency_ms',
  'first_byte_ms',
  'bytes',
  'count',
  'rate',
  'budget_consumed_pct',
  'snapshot_age_ms',
  'outbox_age_ms',
  'outbox_depth',
  'billing_lag_ms',
  'reconcile_variance_micros',
  'kms_failures',
  'circuit_state',
  'fallback_used',
  'dead_letter_count',
  'duplicate_count',
  'retried_count',
  'published_count',
  'claimed_count',
  'http_user_agent',
  'http_referer',
  'remote_ip',
] as const

export type LogField = (typeof LOG_FIELD_ALLOWLIST)[number]

/**
 * Field names whose value is always a secret. Matching is case-insensitive and
 * covers common spellings. A denylisted key is replaced even if it also appears
 * in the allowlist (it should not, but the denylist wins regardless).
 */
const DENYLIST = [
  'authorization',
  'cookie',
  'secret',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'session_token',
  'private_key',
  'client_secret',
  'prompt',
  'response',
  'completion',
  'body',
  'upstream_body',
  'credential',
  'credential_secret',
  'encrypted_data_key',
  'dek',
  'plaintext',
  'master_key',
  'passphrase',
  'token',
  'auth',
]

const DENYSET = new Set<string>(DENYLIST)

/** True when a key name (exact, lowercased) is a denied field. */
export function isDeniedField(key: string): boolean {
  return DENYSET.has(key.toLowerCase())
}

/** True when a key is on the allowlist (and not denied). */
export function isAllowedField(key: string): boolean {
  const lower = key.toLowerCase()
  if (DENYSET.has(lower)) return false
  return (LOG_FIELD_ALLOWLIST as readonly string[]).includes(lower)
}

/**
 * Filter a fields object to only allowlisted, non-denied entries. Returns a new
 * object; the input is not mutated. Non-string values for allowed keys are
 * passed through (numbers, booleans, null). Nested objects are not recursed —
 * the contract is a flat key/value log line.
 */
export function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (isDeniedField(key)) {
      out[key] = '[REDACTED]'
      continue
    }
    if (!isAllowedField(key)) continue
    if (typeof value === 'string') {
      out[key] = redactInlineSecrets(value)
    } else {
      out[key] = value
    }
  }
  return out
}

// Inline secret patterns scrubbed from otherwise-allowed string values.
const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
  /sk-nx-[A-Za-z0-9_-]{8,}/g, // NexusAPI downstream keys
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, // generic provider keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic keys
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization header values
  /\bnx1\.[A-Za-z0-9+/=_-]{16,}/g, // envelope blobs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

const REDACTED = '[REDACTED]'

/** Scrub inline secret patterns from a string value. */
export function redactInlineSecrets(input: string): string {
  let out = input
  for (const re of INLINE_SECRET_PATTERNS) out = out.replace(re, REDACTED)
  // Bound the length so a leaked prompt-sized string cannot flood the log.
  return out.length > 4096 ? out.slice(0, 4096) + '…[truncated]' : out
}
