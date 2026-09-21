/**
 * Owned-access connector capability contract.
 *
 * Connectors expose only opaque references and redacted telemetry to the control
 * plane. Secrets remain in the customer's device/VPC or configured secret manager.
 */
export const CONNECTOR_CAPABILITY_SCHEMA_VERSION = 1 as const

export type ConnectorAuthMode = 'api_key' | 'oauth_subscription' | 'native_login' | 'external_endpoint'

export type ConnectorExecutionMode = 'direct_api' | 'local_sidecar' | 'customer_vpc_runner' | 'external_endpoint'

export type ConnectorRevocationState = 'active' | 'revoked' | 'expired' | 'missing'

export type ConnectorOperation = 'chat' | 'embeddings' | 'models' | 'quota' | 'health'

export interface ConnectorCapability {
  schema_version: typeof CONNECTOR_CAPABILITY_SCHEMA_VERSION
  connector_id: string
  version: string
  provider: string
  auth_mode: ConnectorAuthMode
  execution_mode: ConnectorExecutionMode
  supported_operations: ConnectorOperation[]
  required_scopes: string[]
  credential_reference_type: 'opaque_ref' | 'fingerprint' | 'customer_secret_manager'
  heartbeat: {
    observed_at: string
    expires_at: string
  }
  revocation_state: ConnectorRevocationState
}

export interface ConnectorQuotaSnapshot {
  metadata?: import('./quota').QuotaSnapshotMetadata
  snapshot_id: string
  plan?: string
  window?: string
  used?: number | string | null
  remaining?: number | string | null
  reset_at?: string
  source: string
  observed_at: string
  stale_at: string
  confidence: 'authoritative' | 'reported' | 'estimated' | 'unknown'
}

export type ConnectorBillingMode = 'metered' | 'estimated' | 'subscription' | 'unknown'

export interface ConnectorUsageEvent {
  event_id: string
  tenant_id: string
  connector_id: string
  request_id: string
  status: 'completed' | 'failed' | 'unknown_completion'
  billing_mode: ConnectorBillingMode
  price_version?: string
  quota_snapshot_id?: string
  usage?: { input_tokens: number; output_tokens: number }
  occurred_at: string
}

export type ConnectorErrorCode =
  | 'credential_missing'
  | 'credential_expired'
  | 'credential_revoked'
  | 'permission_denied'
  | 'transient_rate_limited'
  | 'upstream_unavailable'
  | 'unknown_completion'

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode
  readonly retryable: boolean
  readonly tenantId: string

  constructor(code: ConnectorErrorCode, tenantId: string, message: string, retryable = false) {
    super(message)
    this.name = 'ConnectorError'
    this.code = code
    this.retryable = retryable
    this.tenantId = tenantId
  }
}

export function assertCanStartWork(capability: Pick<ConnectorCapability, 'revocation_state'>, tenantId: string): void {
  if (capability.revocation_state === 'missing') {
    throw new ConnectorError('credential_missing', tenantId, 'Connector credential is missing')
  }
  if (capability.revocation_state === 'expired') {
    throw new ConnectorError('credential_expired', tenantId, 'Connector credential has expired')
  }
  if (capability.revocation_state === 'revoked') {
    throw new ConnectorError('credential_revoked', tenantId, 'Connector credential was revoked')
  }
}

export function unknownCompletion(tenantId: string, message = 'Upstream completion state is unknown') {
  return new ConnectorError('unknown_completion', tenantId, message)
}
