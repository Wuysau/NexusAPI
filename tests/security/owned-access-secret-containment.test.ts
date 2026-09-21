import { describe, expect, it } from 'vitest'
import { MockDirectApiConnector, MockLocalCodexConnector } from '../../packages/contracts/mock-connectors'
import { ConnectorLifecycle } from '../../packages/contracts/connector-lifecycle'

const CANARY = 'CANARY_RAW_PROVIDER_SECRET_7f3c'

describe('owned-access secret containment canary', () => {
  it('never serializes the canary in connector capability, result or usage event', async () => {
    const connector = new MockDirectApiConnector({ tenant_id: 'tenant-a', credential: CANARY })
    const result = await connector.execute({
      tenant_id: 'tenant-a',
      request_id: 'req-canary-123456',
      model: 'mock',
      prompt: CANARY,
    })
    const serialized = JSON.stringify({ capability: connector.capability, result })
    expect(serialized).not.toContain(CANARY)
    expect(serialized).not.toContain('prompt')
  })

  it('keeps local login canary out of control-plane lifecycle metadata', () => {
    const connector = new MockLocalCodexConnector({ tenant_id: 'tenant-a', credential: CANARY })
    const lifecycle = new ConnectorLifecycle('tenant-a', connector.capability.connector_id)
    lifecycle.consent('mock-fingerprint')
    const serialized = JSON.stringify({ capability: connector.capability, lifecycle: lifecycle.snapshot() })
    expect(serialized).not.toContain(CANARY)
    expect(serialized).not.toContain(CANARY)
  })
})
