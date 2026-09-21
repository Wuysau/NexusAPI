import { validateUsageAttributionV2, validateUsageRequestFieldV2, type UsageEventAttributionV2 } from './usage-event-v2'

export type RequestAttributionContext = Pick<
  UsageEventAttributionV2,
  'project_id' | 'project_name' | 'api_key_id' | 'key_kind' | 'principal_id' | 'attribution_status'
> & {
  requested_model: string
  streaming: boolean
  catalog_version_id: string
  policy_version_id: string | null
}

/** Private Gateway → accounting-domain authorization. Never contains model bodies or credentials. */
export interface BudgetRequestV1 {
  version: 1
  tenant_id: string
  organization_id: string
  request_id: string
  idempotency_key?: string
  key_id: string
  model_id: string
  provider: string
  currency: string
  price_version_id: string
  sale_price_snapshot_id: string
  exchange_rate_snapshot_id: string | null
  estimated_input_tokens: number
  estimated_output_tokens: number
  ttl_seconds: number
  attribution_context?: RequestAttributionContext
}

export interface BudgetGrantV1 {
  reservation_id: string
  amount_micros: string
  currency: string
  expires_at: string
  replayed: boolean
}

export function isBudgetRequest(value: unknown): value is BudgetRequestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const fields = [
    'tenant_id',
    'organization_id',
    'request_id',
    'key_id',
    'model_id',
    'provider',
    'currency',
    'price_version_id',
    'sale_price_snapshot_id',
  ]
  const allowed = new Set([
    ...fields,
    'version',
    'idempotency_key',
    'exchange_rate_snapshot_id',
    'estimated_input_tokens',
    'estimated_output_tokens',
    'ttl_seconds',
    'attribution_context',
  ])
  if (Object.keys(row).some((key) => !allowed.has(key))) return false
  if (
    row.idempotency_key !== undefined &&
    (typeof row.idempotency_key !== 'string' ||
      !row.idempotency_key ||
      row.idempotency_key.length > 256 ||
      row.idempotency_key.trim() !== row.idempotency_key)
  )
    return false
  if (
    row.version !== 1 ||
    fields.some(
      (key) =>
        typeof row[key] !== 'string' ||
        !row[key] ||
        (row[key] as string).length > 256 ||
        (row[key] as string).trim() !== row[key],
    )
  )
    return false
  if (
    row.exchange_rate_snapshot_id !== null &&
    (typeof row.exchange_rate_snapshot_id !== 'string' ||
      !row.exchange_rate_snapshot_id ||
      row.exchange_rate_snapshot_id.length > 256)
  )
    return false
  if (!/^[A-Z]{3}$/.test(row.currency as string)) return false
  if (row.attribution_context !== undefined) {
    const context = row.attribution_context
    if (!context || typeof context !== 'object' || Array.isArray(context)) return false
    const capture = context as Record<string, unknown>
    const captureFields = new Set([
      'project_id',
      'project_name',
      'api_key_id',
      'key_kind',
      'principal_id',
      'attribution_status',
      'requested_model',
      'streaming',
      'catalog_version_id',
      'policy_version_id',
    ])
    if (Object.keys(capture).some((key) => !captureFields.has(key))) return false
    const { requested_model, streaming, catalog_version_id, policy_version_id, ...attribution } = capture
    if (
      !validateUsageRequestFieldV2('requested_model', requested_model) ||
      !validateUsageRequestFieldV2('catalog_version_id', catalog_version_id) ||
      !validateUsageRequestFieldV2('policy_version_id', policy_version_id)
    )
      return false
    if (
      typeof streaming !== 'boolean' ||
      [requested_model, catalog_version_id].some((v) => typeof v !== 'string' || !v || v.trim() !== v) ||
      (policy_version_id !== null && (typeof policy_version_id !== 'string' || !policy_version_id)) ||
      attribution.api_key_id !== row.key_id ||
      attribution.attribution_status === 'unknown' ||
      !validateUsageAttributionV2({
        ...attribution,
        connection_id: null,
        credential_id: null,
        channel_id: null,
        execution_mode: 'managed',
      })
    )
      return false
  }
  for (const key of ['estimated_input_tokens', 'estimated_output_tokens']) {
    if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0 || Number(row[key]) > 4_194_304) return false
  }
  return Number.isInteger(row.ttl_seconds) && Number(row.ttl_seconds) >= 30 && Number(row.ttl_seconds) <= 3600
}
