import { beforeEach, expect, it, vi } from 'vitest'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'

const { query, publishLocalCredential, createLocalConnection } = vi.hoisted(() => ({
  query: vi.fn(),
  publishLocalCredential: vi.fn(),
  createLocalConnection: vi.fn(),
}))

vi.mock('@/db', () => ({ pool: { connect: async () => ({ query, release: vi.fn() }) } }))
vi.mock('@/app/api/_lib/control-plane', () => ({ auditControlPlane: vi.fn() }))
vi.mock('./local-routing', () => ({ createLocalConnection }))
vi.mock('./local-credentials', () => ({
  LocalCredentialError: class extends Error {},
  localConnectionConfig: () => ({ baseUrl: 'https://example.invalid/v1', protocol: 'openai', model: 'example-model' }),
  publishLocalCredential,
  removeLocalCredential: vi.fn(),
}))

import { createLocalChannel } from './local-management'

beforeEach(() => {
  query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id FROM providers WHERE code='custom'")) return { rows: [{ id: 'actual-provider-id' }] }
    if (sql.includes('INSERT INTO channels')) return { rows: [{ id: 'new-channel-id' }] }
    return { rows: [] }
  })
  publishLocalCredential.mockReset().mockResolvedValue({ fingerprint: 'fixture-fingerprint' })
  createLocalConnection.mockReset().mockResolvedValue('new-connection-id')
})

it('registers a custom provider and uses its actual ID for every local channel binding', async () => {
  const context = {
    tenantId: 'tenant-test',
    organizationId: 'organization-test',
    session: { userId: 'user-test' },
  } as ControlPlaneContext

  await expect(
    createLocalChannel(context, {
      name: 'Custom upstream',
      providerId: 'custom',
      customProvider: true,
      secret: 'synthetic-key',
      baseUrl: 'https://example.invalid/v1',
      protocol: 'openai',
      model: 'example-model',
      capabilities: ['chat'],
      weight: 10,
      priority: 0,
      region: 'global',
    }),
  ).resolves.toEqual({ id: 'new-channel-id', created: true })

  expect(query.mock.calls.some(([sql]) => sql.includes("VALUES('custom','自定义'"))).toBe(true)
  expect(publishLocalCredential.mock.calls[0][0].provider_id).toBe('actual-provider-id')
  expect(createLocalConnection.mock.calls[0][2]).toBe('actual-provider-id')
  const credentialInsert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO provider_credentials'))
  const channelInsert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO channels'))
  expect(credentialInsert?.[1][1]).toBe('actual-provider-id')
  expect(channelInsert?.[1][1]).toBe('actual-provider-id')
})
