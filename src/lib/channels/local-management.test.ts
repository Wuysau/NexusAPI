import { beforeEach, expect, it, vi } from 'vitest'
import type { ControlPlaneContext } from '@/app/api/_lib/control-plane'

const { query, publishLocalCredential, readLocalCredential, removeLocalCredential, createLocalConnection } = vi.hoisted(
  () => ({
    query: vi.fn(),
    publishLocalCredential: vi.fn(),
    readLocalCredential: vi.fn(),
    removeLocalCredential: vi.fn(),
    createLocalConnection: vi.fn(),
  }),
)

vi.mock('@/db', () => ({ pool: { connect: async () => ({ query, release: vi.fn() }) } }))
vi.mock('@/app/api/_lib/control-plane', () => ({ auditControlPlane: vi.fn() }))
vi.mock('./local-routing', () => ({ createLocalConnection }))
vi.mock('./local-credentials', () => ({
  LocalCredentialError: class extends Error {},
  localConnectionConfig: (input: { model: string }) => ({
    baseUrl: 'https://example.invalid/v1',
    protocol: 'openai',
    model: input.model,
  }),
  localModelIds: (value: string | string[]) => (Array.isArray(value) ? value : [value]),
  publishLocalCredential,
  readLocalCredential,
  removeLocalCredential,
  LOCAL_CREDENTIAL_FORMAT: 'nexus.local-credential.v1',
  LOCAL_CREDENTIAL_MODELS_FORMAT: 'nexus.local-credential.v2',
}))

import { createLocalChannel, upgradeLocalChannelCredentialModels } from './local-management'

beforeEach(() => {
  query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id FROM providers WHERE code='custom'")) return { rows: [{ id: 'actual-provider-id' }] }
    if (sql.includes('INSERT INTO channels')) return { rows: [{ id: 'new-channel-id' }] }
    return { rows: [] }
  })
  publishLocalCredential.mockReset().mockResolvedValue({ fingerprint: 'fixture-fingerprint' })
  readLocalCredential.mockReset().mockResolvedValue('synthetic-existing-key')
  removeLocalCredential.mockReset().mockResolvedValue(undefined)
  createLocalConnection.mockReset().mockResolvedValue('new-connection-id')
})

const repairContext = {
  tenantId: 'tenant-test',
  organizationId: 'organization-test',
  session: { userId: 'user-test' },
} as ControlPlaneContext
const legacyEnvelope = { format: 'nexus.local-credential.v1', fingerprint: 'fixture-fingerprint' }
const repairRow = () => ({
  provider_id: 'provider-test',
  provider_credential_id: 'fixture-credential-id',
  encrypted_secret: JSON.stringify(legacyEnvelope),
  metadata: {
    credential_storage: 'local',
    credential_version: 1,
    base_url: 'https://example.invalid/v1',
    protocol: 'openai',
    model: 'model-large',
    models: ['model-large', 'model-fast'],
  },
})
function setupRepair(row = repairRow()) {
  query.mockImplementation(async (sql: string) =>
    sql.includes('FOR UPDATE OF c,p') ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 1 },
  )
}
it('upgrades only saved models after matching the locked database envelope to the encrypted file', async () => {
  setupRepair()
  await expect(upgradeLocalChannelCredentialModels(repairContext, 'channel-test', 1)).resolves.toEqual({
    id: 'channel-test',
    updated: true,
    version: 2,
  })
  expect(readLocalCredential).toHaveBeenCalledWith(
    expect.objectContaining({ credential_version: 1, model: 'model-large' }),
    undefined,
    legacyEnvelope,
  )
  expect(publishLocalCredential).toHaveBeenCalledWith(
    expect.objectContaining({ credential_version: 2, model: 'model-large', models: ['model-large', 'model-fast'] }),
    'synthetic-existing-key',
  )
  const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE provider_credentials'))
  expect(update?.[0]).toContain('encrypted_secret=$5')
  expect(update?.[1][4]).toBe(JSON.stringify(legacyEnvelope))
  expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true)
  expect(removeLocalCredential).toHaveBeenCalledWith(expect.objectContaining({ credential_version: 1 }))
})
it('rejects a stale expected version without decrypting or publishing', async () => {
  setupRepair()
  await expect(upgradeLocalChannelCredentialModels(repairContext, 'channel-test', 2)).rejects.toThrow()
  expect(readLocalCredential).not.toHaveBeenCalled()
  expect(publishLocalCredential).not.toHaveBeenCalled()
  expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true)
})
it('rejects an inconsistent encrypted file before publishing a replacement', async () => {
  setupRepair()
  readLocalCredential.mockRejectedValueOnce(new Error('credential unavailable'))
  await expect(upgradeLocalChannelCredentialModels(repairContext, 'channel-test', 1)).rejects.toThrow()
  expect(publishLocalCredential).not.toHaveBeenCalled()
  expect(removeLocalCredential).not.toHaveBeenCalled()
})
it('rolls back and removes only the newly published file when a guarded update loses its version', async () => {
  setupRepair()
  query.mockImplementation(async (sql: string) =>
    sql.includes('FOR UPDATE OF c,p')
      ? { rows: [repairRow()], rowCount: 1 }
      : { rows: [], rowCount: sql.includes('UPDATE channels') ? 0 : 1 },
  )
  await expect(upgradeLocalChannelCredentialModels(repairContext, 'channel-test', 1)).rejects.toThrow()
  expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true)
  expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false)
  expect(removeLocalCredential).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ credential_version: 2 }))
})
it('does not delete a version file it did not publish if immutable publication fails', async () => {
  setupRepair()
  publishLocalCredential.mockRejectedValueOnce(new Error('immutable file exists'))
  await expect(upgradeLocalChannelCredentialModels(repairContext, 'channel-test', 1)).rejects.toThrow()
  expect(removeLocalCredential).not.toHaveBeenCalled()
})
it('checks a current v2 envelope and leaves its version and key unchanged', async () => {
  const row = repairRow()
  row.encrypted_secret = JSON.stringify({ ...legacyEnvelope, format: 'nexus.local-credential.v2' })
  setupRepair(row)
  await expect(upgradeLocalChannelCredentialModels(repairContext, 'channel-test', 1)).resolves.toEqual({
    id: 'channel-test',
    updated: false,
    version: 1,
  })
  expect(readLocalCredential).toHaveBeenCalledOnce()
  expect(publishLocalCredential).not.toHaveBeenCalled()
  expect(removeLocalCredential).not.toHaveBeenCalled()
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
      models: ['model-large', 'model-fast'],
      capabilities: ['chat'],
      weight: 10,
      priority: 0,
      region: 'global',
    }),
  ).resolves.toEqual({ id: 'new-channel-id', created: true })

  expect(query.mock.calls.some(([sql]) => sql.includes("VALUES('custom','自定义'"))).toBe(true)
  expect(publishLocalCredential.mock.calls[0][0].provider_id).toBe('actual-provider-id')
  expect(publishLocalCredential.mock.calls[0][0].model).toBe('model-large')
  expect(publishLocalCredential.mock.calls[0][0].models).toEqual(['model-large', 'model-fast'])
  expect(createLocalConnection.mock.calls[0][2]).toBe('actual-provider-id')
  const credentialInsert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO provider_credentials'))
  const channelInsert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO channels'))
  expect(credentialInsert?.[1][1]).toBe('actual-provider-id')
  expect(channelInsert?.[1][1]).toBe('actual-provider-id')
  expect(JSON.parse(channelInsert?.[1][8])).toMatchObject({
    model: 'model-large',
    models: ['model-large', 'model-fast'],
  })
})
