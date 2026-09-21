import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { canonicalJson } from '@/lib/catalog/snapshot'
import { snapshotSigningKeyring } from '@/lib/secrets/snapshot-signing'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/db', () => ({ pool: { query } }))
import { GET } from '@/app/api/internal/gateway/snapshot/route'

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('NEXUS_DESKTOP_ORIGIN', 'http://127.0.0.1:3340')
  vi.stubEnv('GATEWAY_INTERNAL_TOKEN', 'local-snapshot-test-token')
  vi.stubEnv('SNAPSHOT_SIGNING_KEY', 'local-snapshot-test-signing-key')
  query.mockReset().mockResolvedValue({ rows: [] })
})
afterEach(() => vi.unstubAllEnvs())
const request = (scope = '', host = '127.0.0.1:3340', token = 'local-snapshot-test-token') =>
  new Request(`http://127.0.0.1:3340/api/internal/gateway/snapshot${scope}`, {
    headers: { host, authorization: `Bearer ${token}` },
  })

it('signs a platform key directory without querying published or private catalog facts', async () => {
  const response = await GET(request())
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.bundle.channels).toEqual([])
  expect(body.bundle.models).toEqual([])
  expect(body.bundle.snapshot.price_versions).toEqual([])
  expect(body.signature).toBe(
    createHmac('sha256', snapshotSigningKeyring().current.key).update(canonicalJson(body.bundle)).digest('hex'),
  )
  expect(query.mock.calls.every(([sql]) => sql.includes('downstream_api_keys'))).toBe(true)
})

it('keeps internal authentication mandatory even in the local desktop profile', async () => {
  expect((await GET(request('', undefined, 'wrong'))).status).toBe(401)
  expect(query).not.toHaveBeenCalled()
})

it.each(['production', 'wrong-host', 'no-profile'])('retains published snapshot requirements for %s', async (mode) => {
  if (mode === 'production') vi.stubEnv('NODE_ENV', 'production')
  if (mode === 'no-profile') vi.stubEnv('NEXUS_DESKTOP_ORIGIN', '')
  const response = await GET(request('', mode === 'wrong-host' ? 'remote.invalid' : undefined))
  expect(response.status).toBe(404)
  expect(query.mock.calls[0][0]).toContain('gateway_snapshots')
})

function savedChannel(over: Record<string, unknown> = {}) {
  return {
    id: 'local-channel',
    tenant_id: 'tenant-a',
    provider_id: 'provider-a',
    provider_code: 'custom',
    official_base_url: 'https://official.invalid',
    auth_scheme: 'bearer',
    credential_id: 'credential-a',
    credential_fingerprint: 'fingerprint',
    credential_tenant_id: 'tenant-a',
    credential_platform_managed: false,
    credential_provider_id: 'provider-a',
    credential_organization_id: 'org-a',
    credential_org_tenant_id: 'tenant-a',
    credential_enabled: true,
    connection_id: 'connection-a',
    connection_tenant_id: 'tenant-a',
    connection_revoked_at: null,
    connection_mode: 'external_endpoint',
    connection_provider: 'custom',
    connection_credential_ref: 'credential-a',
    name: 'Local',
    capabilities: ['text'],
    region: 'global',
    weight: 1,
    priority: 1,
    metadata: {
      credential_storage: 'local',
      base_url: 'https://saved.invalid/v1',
      protocol: 'openai',
      model: 'saved/model',
      credential_version: 1,
      connection_id: 'connection-a',
    },
    models: ['unrelated/shared-model'],
    ...over,
  }
}

it('exports saved protocol/model/endpoint without querying or promoting the shared model catalog', async () => {
  query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM channels c')) {
      expect(sql).not.toContain('FROM upstream_models')
      expect(sql).toContain("AND c.tenant_id = $1 AND c.metadata->>'credential_storage' = 'local'")
      expect(params).toEqual(['tenant-a'])
      return { rows: [savedChannel()] }
    }
    expect(sql).toContain('downstream_api_keys')
    return { rows: [] }
  })
  const response = await GET(request('?tenant_id=tenant-a'))
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.bundle.channels).toEqual([
    expect.objectContaining({
      models: ['saved/model'],
      base_url: 'https://saved.invalid/v1',
      protocol: 'openai',
      credential_mode: 'byok',
      connection_id: 'connection-a',
      credential_ref: 'credential-a',
    }),
  ])
  expect(body.bundle.models.map((m: { id: string }) => m.id)).toEqual(['saved/model'])
  expect(body.bundle.snapshot.price_versions).toEqual([])
})

it.each([
  { connection_tenant_id: 'tenant-b' },
  { credential_org_tenant_id: 'tenant-b' },
  { connection_credential_ref: 'another-credential' },
  { connection_revoked_at: new Date() },
  { connection_provider: 'another-provider' },
  { connection_mode: 'subscription_interactive' },
  { credential_enabled: false },
])('refuses to sign invalid local identity: %o', async (over) => {
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM channels c') ? [savedChannel(over)] : [],
  }))
  const response = await GET(request('?tenant_id=tenant-a'))
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain('signature')
})

it('retains project attribution and disables unknown projects in the local key directory', async () => {
  const key = {
    id: 'key-a',
    tenant_id: 'tenant-a',
    organization_id: 'org-a',
    hash: 'test-digest',
    fingerprint: 'fingerprint',
    scopes: ['chat'],
    enabled: true,
    expires_at: null,
    revoked_at: null,
    project_id: 'project-a',
    project_name: 'Project A',
    project_tenant_id: 'tenant-a',
    project_organization_id: 'org-a',
    project_status: 'active',
    project_archived_at: null,
    org_tenant_id: 'tenant-a',
    org_deleted_at: null,
  }
  query.mockResolvedValue({ rows: [key] })
  const first = await (await GET(request())).json()
  expect(first.bundle.keys[0]).toMatchObject({
    enabled: true,
    attribution_status: 'attributed',
    project_id: 'project-a',
  })
  query.mockResolvedValue({ rows: [{ ...key, project_status: 'archived' }] })
  const archived = await (await GET(request())).json()
  expect(archived.bundle.keys[0]).toMatchObject({ enabled: false, attribution_status: 'unknown', project_id: null })
  query.mockResolvedValue({ rows: [{ ...key, project_tenant_id: 'tenant-b' }] })
  expect((await GET(request())).status).toBe(500)
})
