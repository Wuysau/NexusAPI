import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/app/api/_lib/control-plane', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/app/api/_lib/control-plane')
  const context = async () => ({
    tenantId: 'opaque-tenant',
    organizationId: 'opaque-org',
    principal: { userId: 'operator' },
  })
  return {
    ...actual,
    requireContext: context,
    requireHighRiskContext: context,
    auditControlPlane: async () => {},
  }
})
import { pool } from '@/db'
import { POST } from '@/app/api/channels/route'
import { PATCH } from '@/app/api/channels/[id]/route'
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const request = (body: unknown, origin = 'https://console.example.com') =>
  new Request(`${origin}/api/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', host: new URL(origin).host, origin },
    body: JSON.stringify(body),
  })
beforeEach(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(
    "INSERT INTO organizations(id,tenant_id,name,slug) VALUES('opaque-org','opaque-tenant','Opaque','opaque'),('other-org','other-tenant','Other','other'); INSERT INTO providers(id,code,name,official_base_url) VALUES('provider','fixture','Fixture','https://api.example.com')",
  )
})
afterAll(async () => {
  await pool.end()
})
afterEach(() => vi.unstubAllEnvs())
describe('Control Plane opaque channel enrollment', () => {
  it('preserves an explicit immutable credential version and rejects invalid versions', async () => {
    expect(
      (
        await POST(
          request({
            name: 'versioned',
            provider: 'fixture',
            credentialId: 'versioned-credential',
            credentialVersion: 2,
          }),
        )
      ).status,
    ).toBe(201)
    expect((await pool.query('SELECT metadata FROM channels')).rows[0].metadata.credential_version).toBe(2)
    for (const credentialVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) {
      expect(
        (await POST(request({ name: 'bad', provider: 'fixture', credentialId: 'bad-version', credentialVersion })))
          .status,
      ).toBe(400)
    }
  })
  it.each(['remote', 'production'])(
    'rejects %s plaintext onboarding and rotation without persisting it',
    async (mode) => {
      vi.stubEnv('NODE_ENV', mode === 'production' ? 'production' : 'test')
      vi.stubEnv('NEXUS_DESKTOP_ORIGIN', 'http://localhost:3340')
      const origin = mode === 'production' ? 'http://localhost:3340' : 'https://console.example.com'
      const result = await POST(
        request({ name: 'channel', provider: 'fixture', secret: 'synthetic-private-canary' }, origin),
      )
      expect(result.status).toBe(403)
      const onboardingBody = await result.text()
      expect(onboardingBody).toContain('local_key_input_unavailable')
      expect(onboardingBody).not.toContain('synthetic-private-canary')
      expect((await pool.query('SELECT count(*) FROM provider_credentials')).rows[0].count).toBe('0')
      await POST(request({ name: 'channel', provider: 'fixture', credentialId: 'registered-credential' }))
      const id = (await pool.query('SELECT id FROM channels')).rows[0].id
      const rotation = await PATCH(request({ secret: 'synthetic-private-canary' }, origin), {
        params: Promise.resolve({ id }),
      })
      expect(rotation.status).toBe(403)
      const rotationBody = await rotation.text()
      expect(rotationBody).toContain('local_key_input_unavailable')
      expect(rotationBody).not.toContain('synthetic-private-canary')
      expect((await pool.query('SELECT encrypted_secret FROM provider_credentials')).rows[0].encrypted_secret).toBe(
        'external-registry:v1',
      )
    },
  )
  it('stores only the opaque reference and refuses cross-tenant reference reuse', async () => {
    const created = await POST(request({ name: 'channel', provider: 'fixture', credentialId: 'registered-credential' }))
    expect(created.status).toBe(201)
    const stored = (await pool.query('SELECT * FROM provider_credentials')).rows[0]
    expect(stored.id).toBe('registered-credential')
    expect(stored.encrypted_data_key).toBeNull()
    expect(stored.encrypted_secret).toBe('external-registry:v1')
    await pool.query(
      "INSERT INTO provider_credentials(id,provider_id,organization_id,tenant_id,name,encrypted_secret) VALUES('other-credential','provider','other-org','other-tenant','Other','external-registry:v1')",
    )
    expect(
      (await POST(request({ name: 'crossed', provider: 'fixture', credentialId: 'other-credential' }))).status,
    ).toBe(409)
    expect((await pool.query('SELECT count(*) FROM channels')).rows[0].count).toBe('1')
  })
})
