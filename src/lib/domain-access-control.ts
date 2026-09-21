/**
 * Owned-access policy decisions shared by control plane and connector runtimes.
 * Unknown capabilities fail closed; subscription credentials never become a
 * generic server-side API route.
 */
export type ExecutionMode =
  'direct_api' | 'local_sidecar' | 'customer_vpc_runner' | 'external_endpoint' | 'subscription_interactive'
export type ProxyStatus = 'allowed' | 'customer-controlled-only' | 'unknown' | 'not-allowed'

export interface AccessCapability {
  mode: ExecutionMode
  proxyStatus: ProxyStatus
  provider: string
  operations: readonly string[]
  revoked?: boolean
  expiresAt?: Date | null
}

export interface AccessRequest {
  tenantId: string
  projectTenantId: string
  ownerId: string
  actorId: string
  projectId: string
  connectionId: string
  operation: string
  now?: Date
}

export type AccessDenyReason =
  | 'tenant_isolation'
  | 'owner_consent_required'
  | 'connection_revoked'
  | 'connection_expired'
  | 'operation_not_supported'
  | 'server_proxy_not_allowed'
  | 'unknown_capability'

export type AccessDecision = { allowed: true } | { allowed: false; reason: AccessDenyReason }

/** Evaluate a connector without provider-specific routing branches. */
export function decideOwnedAccess(request: AccessRequest, capability: AccessCapability): AccessDecision {
  if (capability.mode === 'subscription_interactive') return { allowed: false, reason: 'server_proxy_not_allowed' }
  if (request.tenantId !== request.projectTenantId) return { allowed: false, reason: 'tenant_isolation' }
  if (capability.revoked) return { allowed: false, reason: 'connection_revoked' }
  if (capability.expiresAt && capability.expiresAt.getTime() <= (request.now ?? new Date()).getTime()) {
    return { allowed: false, reason: 'connection_expired' }
  }
  if (!capability.operations.includes(request.operation)) return { allowed: false, reason: 'operation_not_supported' }
  if (capability.proxyStatus === 'unknown') return { allowed: false, reason: 'unknown_capability' }
  if (capability.mode === 'direct_api' && capability.proxyStatus !== 'allowed') {
    return { allowed: false, reason: 'server_proxy_not_allowed' }
  }
  if (capability.mode !== 'direct_api' && capability.proxyStatus !== 'customer-controlled-only') {
    return { allowed: false, reason: 'server_proxy_not_allowed' }
  }
  if (request.ownerId !== request.actorId && capability.mode === 'local_sidecar') {
    return { allowed: false, reason: 'owner_consent_required' }
  }
  return { allowed: true }
}
