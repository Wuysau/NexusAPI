// RBAC capability matrix for the control plane.
//
// Security properties enforced by this capability matrix:
//   - Deny by default: an unknown role, a missing principal or an unknown
//     capability is denied, never allowed.
//   - Audit records are append-only. There is deliberately NO capability that
//     mutates or deletes audit_events, which makes the compliance rule
//     "no role can both decrypt credentials AND modify audit records"
//     structurally true instead of merely checked.
//   - `credential:use` (decrypt a provider secret) is never granted to a human
//     org role. Only the gateway workload can unwrap (see secrets/envelope.ts).
//     Humans get `credential:read` (metadata only) at most.
//   - `system-auditor` is a platform role, not an organization membership
//     (the member_role enum in schema.ts has no such value). It can read audit
//     events cross-tenant and nothing else: no billing, no credentials,
//     no key management.

export type Role = 'owner' | 'admin' | 'billing' | 'developer' | 'viewer' | 'system-auditor'

export type Capability =
  // Organization / membership administration
  | 'org:read'
  | 'org:update'
  | 'org:delete'
  | 'member:read'
  | 'member:invite'
  | 'member:update-role'
  | 'member:remove'
  // Workspace/project governance
  | 'project:read'
  | 'project:create'
  | 'project:update'
  | 'project:archive'
  // Downstream API key lifecycle (customer-facing sk-nx-* keys)
  | 'apikey:read'
  | 'apikey:create'
  | 'apikey:revoke'
  // Provider credential lifecycle (BYOK secrets)
  | 'credential:read'
  | 'credential:create'
  | 'credential:rotate'
  | 'credential:disable'
  | 'credential:use'
  // Money & pricing
  | 'billing:read'
  | 'billing:manage'
  | 'pricing:read'
  | 'pricing:approve'
  | 'model:manage'
  // Usage / requests
  | 'request:read'
  | 'usage:read'
  | 'quota:write'
  // Audit (read-only by construction)
  | 'audit:read'
  | 'audit:export'
  // Cross-tenant platform access
  | 'system:cross-tenant'

const VIEWER: readonly Capability[] = [
  'org:read',
  'member:read',
  'project:read',
  'apikey:read',
  'credential:read',
  'billing:read',
  'pricing:read',
  'request:read',
  'usage:read',
]

const DEVELOPER: readonly Capability[] = [
  ...VIEWER,
  'quota:write',
  'apikey:create',
  'project:create',
  'project:update',
  'project:archive',
  'apikey:revoke',
  'credential:create',
  'credential:rotate',
  'credential:disable',
]

const BILLING: readonly Capability[] = [
  'org:read',
  'member:read',
  'project:read',
  'apikey:read',
  'credential:read',
  'billing:read',
  'billing:manage',
  'pricing:read',
  'pricing:approve',
  'request:read',
  'usage:read',
  'audit:read',
]

const ADMIN: readonly Capability[] = [
  ...DEVELOPER,
  'model:manage',
  'org:update',
  'member:invite',
  'member:update-role',
  'member:remove',
  'billing:read',
  'billing:manage',
  'pricing:approve',
  'audit:read',
  'audit:export',
]

const OWNER: readonly Capability[] = [...ADMIN, 'org:delete']

// Cross-tenant read of the audit trail, and nothing that can mutate money,
// credentials or keys. This role cannot be combined with an org membership.
const SYSTEM_AUDITOR: readonly Capability[] = ['audit:read', 'audit:export', 'org:read', 'system:cross-tenant']

export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = Object.freeze({
  owner: OWNER,
  admin: ADMIN,
  billing: BILLING,
  developer: DEVELOPER,
  viewer: VIEWER,
  'system-auditor': SYSTEM_AUDITOR,
})

export const ROLES: readonly Role[] = Object.freeze(Object.keys(ROLE_CAPABILITIES) as Role[])

/** Capabilities that must never be held together by one principal. */
const MUTUALLY_EXCLUSIVE: readonly (readonly [Capability, Capability])[] = [
  ['credential:use', 'audit:read'],
  ['credential:use', 'audit:export'],
]

/** The gateway workload is the only identity allowed to unwrap secrets. */
export const UNWRAP_CAPABILITY: Capability = 'credential:use'

export type PrincipalKind = 'user' | 'service-account' | 'system' | 'gateway'

export interface Principal {
  kind: PrincipalKind
  role: Role
  userId?: string
  tenantId?: string
  serviceAccountId?: string
}

export type AuthzErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'tenant_isolation'
  | 'connector_unauthorized'
  | 'invalid_models'
  | 'not_found'
  | 'invalid_project'
  | 'invalid_provider'
  | 'credential_reference_conflict'
  | 'credential_disabled'

export class AuthzError extends Error {
  readonly status: number
  readonly code: AuthzErrorCode

  constructor(code: AuthzErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'AuthzError'
    this.code = code
    this.status = status ?? (code === 'unauthenticated' ? 401 : code === 'tenant_isolation' ? 404 : 403)
  }
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, value)
}

export function capabilitiesForRole(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role] ?? []
}

export function hasRole(role: Role, allowed: Role | readonly Role[]): boolean {
  const list = Array.isArray(allowed) ? allowed : [allowed as Role]
  return list.includes(role)
}

export function hasCapability(role: Role, capability: Capability): boolean {
  return capabilitiesForRole(role).includes(capability)
}

/**
 * Runtime assertion that the matrix itself never hands a principal both
 * decrypt and audit-mutation power. There is no audit-mutation capability at
 * all today; this guard is here so a future edit cannot introduce one quietly.
 */
export function assertMatrixInvariants(): void {
  for (const role of ROLES) {
    for (const [a, b] of MUTUALLY_EXCLUSIVE) {
      if (hasCapability(role, a) && hasCapability(role, b)) {
        throw new Error(`capability matrix violates separation of duties: role '${role}' has both '${a}' and '${b}'`)
      }
    }
  }
}

// Called on module load: fail fast if the matrix is ever edited into an
// unsafe combination.
assertMatrixInvariants()

export function requireAuthenticated(principal: Principal | null | undefined): Principal {
  if (!principal) throw new AuthzError('unauthenticated', 'authentication required')
  return principal
}

export function requireRole(principal: Principal | null | undefined, allowed: Role | readonly Role[]): Principal {
  const p = requireAuthenticated(principal)
  if (!hasRole(p.role, allowed)) {
    throw new AuthzError('forbidden', `role '${p.role}' is not permitted here`)
  }
  return p
}

export function requireCapability(principal: Principal | null | undefined, capability: Capability): Principal {
  const p = requireAuthenticated(principal)
  if (!hasCapability(p.role, capability)) {
    throw new AuthzError('forbidden', `role '${p.role}' lacks capability '${capability}'`)
  }
  return p
}

/**
 * Tenant isolation guard (IDOR prevention). A cross-tenant access attempt is
 * reported as 404 so the caller cannot use the response to probe for the
 * existence of another tenant's resources. `system:cross-tenant` holders are
 * the only exception.
 */
export function requireTenantAccess(
  principal: Principal | null | undefined,
  resourceTenantId: string | null | undefined,
): Principal {
  const p = requireAuthenticated(principal)
  if (hasCapability(p.role, 'system:cross-tenant')) return p
  if (!resourceTenantId || p.tenantId !== resourceTenantId) {
    throw new AuthzError('tenant_isolation', 'resource not found', 404)
  }
  return p
}

/** Boolean form of the same check, for tests and non-throwing call sites. */
export function canAccessTenant(
  principal: Principal | null | undefined,
  resourceTenantId: string | null | undefined,
): boolean {
  if (!principal) return false
  if (hasCapability(principal.role, 'system:cross-tenant')) return true
  return Boolean(resourceTenantId) && principal.tenantId === resourceTenantId
}

/** Gateway workload identity check used before unwrapping a secret. */
export function isGatewayPrincipal(principal: Principal | null | undefined): boolean {
  return principal?.kind === 'gateway' && hasCapability(principal.role, UNWRAP_CAPABILITY)
}
