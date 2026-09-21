import { describe, expect, it } from 'vitest'
import { decideOwnedAccess, type AccessCapability } from './domain-access-control'

const direct: AccessCapability = { mode: 'direct_api', proxyStatus: 'allowed', provider: 'mock', operations: ['chat'] }

describe('owned access policy', () => {
  it('allows same-tenant direct API capability', () => {
    expect(
      decideOwnedAccess(
        {
          tenantId: 't1',
          projectTenantId: 't1',
          ownerId: 'u1',
          actorId: 'u1',
          projectId: 'p1',
          connectionId: 'c1',
          operation: 'chat',
        },
        direct,
      ),
    ).toEqual({ allowed: true })
  })
  it('denies cross-tenant access', () => {
    expect(
      decideOwnedAccess(
        {
          tenantId: 't2',
          projectTenantId: 't1',
          ownerId: 'u1',
          actorId: 'u1',
          projectId: 'p1',
          connectionId: 'c1',
          operation: 'chat',
        },
        direct,
      ),
    ).toEqual({ allowed: false, reason: 'tenant_isolation' })
  })
  it('fails closed for unknown proxy capability', () => {
    expect(
      decideOwnedAccess(
        {
          tenantId: 't1',
          projectTenantId: 't1',
          ownerId: 'u1',
          actorId: 'u1',
          projectId: 'p1',
          connectionId: 'c1',
          operation: 'chat',
        },
        { ...direct, proxyStatus: 'unknown' },
      ),
    ).toEqual({ allowed: false, reason: 'unknown_capability' })
  })
})
