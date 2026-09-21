import { describe, expect, it } from 'vitest'
import { ConnectorLifecycle } from '../../packages/contracts/connector-lifecycle'

describe('connector consent and lifecycle contract', () => {
  it('supports consent, rotate, disconnect, revoke and delete without retaining raw credentials', () => {
    const lifecycle = new ConnectorLifecycle('tenant-a', 'mock-direct:tenant-a')
    expect(lifecycle.snapshot().state).toBe('pending_consent')
    lifecycle.consent('fingerprint-a')
    expect(lifecycle.snapshot()).toMatchObject({ state: 'connected', credential_fingerprint: 'fingerprint-a' })
    lifecycle.rotate('fingerprint-b')
    expect(lifecycle.snapshot()).toMatchObject({ state: 'connected', credential_fingerprint: 'fingerprint-b' })
    lifecycle.disconnect()
    expect(lifecycle.snapshot()).toMatchObject({ state: 'disconnected' })
    expect(lifecycle.snapshot().credential_fingerprint).toBeUndefined()
    lifecycle.revoke()
    expect(lifecycle.snapshot()).toMatchObject({ state: 'revoked' })
    lifecycle.delete()
    expect(lifecycle.snapshot()).toMatchObject({ state: 'deleted' })
  })

  it('does not permit rotation before consent', () => {
    const lifecycle = new ConnectorLifecycle('tenant-a', 'mock-direct:tenant-a')
    expect(() => lifecycle.rotate('fingerprint')).toThrow(/connected state/)
  })
})
