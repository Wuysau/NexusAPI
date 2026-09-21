import { describe, expect, it } from 'vitest'
import { ConnectorError } from '../../packages/contracts/connector'
import { MockDirectApiConnector, MockLocalCodexConnector } from '../../packages/contracts/mock-connectors'

const request = { tenant_id: 'tenant-a', request_id: 'request-1234567890', model: 'mock', prompt: 'hello' }

describe('mock owned-access connectors', () => {
  it('direct API exposes fingerprint only and never raw credential', async () => {
    const secret = 'canary-direct-secret'
    const connector = new MockDirectApiConnector({ tenant_id: 'tenant-a', credential: secret })
    const result = await connector.execute(request)
    expect(result.credential_fingerprint).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result.usage_event.tenant_id).toBe('tenant-a')
  })

  it('local Codex connector uses local-sidecar execution and ownership scope', async () => {
    const connector = new MockLocalCodexConnector({ tenant_id: 'tenant-a', credential: 'canary-local-secret' })
    expect(connector.capability.execution_mode).toBe('local_sidecar')
    await expect(connector.execute({ ...request, tenant_id: 'tenant-b' })).rejects.toMatchObject({
      code: 'permission_denied',
    })
  })

  it('revocation and disconnect refuse new work with typed errors', async () => {
    const revoked = new MockDirectApiConnector({ tenant_id: 'tenant-a', credential: 'secret' })
    revoked.revoke()
    await expect(revoked.execute(request)).rejects.toMatchObject<Partial<ConnectorError>>({
      code: 'credential_revoked',
    })

    const disconnected = new MockDirectApiConnector({ tenant_id: 'tenant-a', credential: 'secret' })
    disconnected.disconnect()
    await expect(disconnected.execute(request)).rejects.toMatchObject<Partial<ConnectorError>>({
      code: 'credential_missing',
    })
  })

  it('ambiguous acceptance is unknown completion, never success', async () => {
    const connector = new MockDirectApiConnector({ tenant_id: 'tenant-a', credential: 'secret', ambiguous: true })
    await expect(connector.execute(request)).rejects.toMatchObject<Partial<ConnectorError>>({
      code: 'unknown_completion',
    })
  })
})
