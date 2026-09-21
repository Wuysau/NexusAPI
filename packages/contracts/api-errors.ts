// Public API error contract v1 — shared binding for
// docs/contracts/api-errors.md.
//
// The gateway's Go implementation lives in services/gateway/errors.go. The two
// must agree on the codes and the HTTP mapping, because a client switching
// between the legacy Next.js gateway and the Go data plane must see identical
// behaviour for identical failures.

/** Error type discriminators. */
export const API_ERROR_TYPES = [
  'authentication_error',
  'permission_error',
  'policy_error',
  'invalid_request_error',
  'rate_limit_error',
  'conflict_error',
  'upstream_error',
  'service_unavailable_error',
  'timeout_error',
] as const

export type ApiErrorType = (typeof API_ERROR_TYPES)[number]

/** Stable, machine-readable public codes. */
export const API_ERROR_CODES = [
  'invalid_api_key',
  'key_revoked',
  'key_expired',
  'key_disabled',
  'scope_denied',
  'model_not_allowed',
  'region_not_allowed',
  'budget_exceeded',
  'rate_limit_exceeded',
  'concurrency_exceeded',
  'invalid_json',
  'request_too_large',
  'invalid_parameter',
  'unsupported_parameter',
  'model_not_found',
  'capability_not_supported',
  'idempotency_conflict',
  'upstream_protocol_error',
  'no_healthy_upstream',
  'snapshot_unavailable',
  'snapshot_expired',
  'storage_unavailable',
  'upstream_timeout',
  'internal_error',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/** The frozen response shape. */
export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode
    message: string
    type: ApiErrorType
    param: string | null
    request_id: string
  }
}

/**
 * The HTTP status each code maps to, from the contract's mapping table. Used by
 * tests to assert the gateway's mapping and by clients to classify retries.
 */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  invalid_api_key: 401,
  key_revoked: 401,
  key_expired: 401,
  key_disabled: 401,
  scope_denied: 403,
  model_not_allowed: 403,
  region_not_allowed: 403,
  budget_exceeded: 429,
  rate_limit_exceeded: 429,
  concurrency_exceeded: 429,
  invalid_json: 400,
  request_too_large: 413,
  invalid_parameter: 400,
  unsupported_parameter: 400,
  model_not_found: 400,
  capability_not_supported: 422,
  idempotency_conflict: 409,
  upstream_protocol_error: 502,
  no_healthy_upstream: 503,
  snapshot_unavailable: 503,
  snapshot_expired: 503,
  storage_unavailable: 503,
  upstream_timeout: 504,
  internal_error: 500,
}

/** True when a client may retry the request without changing anything. */
export function isRetryableCode(code: ApiErrorCode): boolean {
  switch (code) {
    case 'rate_limit_exceeded':
    case 'concurrency_exceeded':
    case 'no_healthy_upstream':
    case 'upstream_protocol_error':
    case 'upstream_timeout':
    case 'snapshot_unavailable':
    case 'snapshot_expired':
    case 'storage_unavailable':
    case 'internal_error':
      return true
    default:
      return false
  }
}
