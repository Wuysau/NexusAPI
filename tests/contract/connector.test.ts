import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertCanStartWork, ConnectorError, unknownCompletion } from '../../packages/contracts/connector'

const capabilitySchema = JSON.parse(
  readFileSync(new URL('../../packages/contracts/connector-capability.schema.json', import.meta.url), 'utf8'),
) as {
  required: string[]
  properties: Record<string, { enum?: string[]; const?: number }>
}

describe('owned-access connector contract', () => {
  it('defines a fail-closed machine-readable capability schema', () => {
    expect(capabilitySchema.required).toContain('connector_id')
    expect(capabilitySchema.required).toContain('heartbeat')
    expect(capabilitySchema.properties.schema_version.const).toBe(1)
    expect(capabilitySchema.properties.execution_mode.enum).toContain('local_sidecar')
    expect(capabilitySchema.properties.auth_mode.enum).toContain('oauth_subscription')
  })

  it.each([
    ['missing', 'credential_missing'],
    ['expired', 'credential_expired'],
    ['revoked', 'credential_revoked'],
  ] as const)('rejects %s credentials without cross-identity fallback', (state, code) => {
    try {
      assertCanStartWork({ revocation_state: state }, 'tenant-a')
      throw new Error('expected connector error')
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError)
      expect((error as ConnectorError).code).toBe(code)
      expect((error as ConnectorError).tenantId).toBe('tenant-a')
    }
  })

  it('returns unknown completion rather than treating acceptance ambiguity as success', () => {
    const error = unknownCompletion('tenant-a')
    expect(error.code).toBe('unknown_completion')
    expect(error.retryable).toBe(false)
  })

  it('allows active credentials', () => {
    expect(() => assertCanStartWork({ revocation_state: 'active' }, 'tenant-a')).not.toThrow()
  })
})
