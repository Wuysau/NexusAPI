import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/db', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }))
import { loadEnv } from '@/lib/config'
import { LocalKms, resolveKmsClient } from '@/lib/secrets/envelope'
import { POST } from '@/app/api/internal/gateway/credential/route'

afterEach(() => vi.unstubAllEnvs())
const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://fixture.invalid/db',
  ADMIN_TOKEN: 'a'.repeat(32),
  APP_BASE_URL: 'https://console.example.com',
  KMS_PROVIDER: 'vault',
  SNAPSHOT_SIGNING_KEY: 's'.repeat(48),
}
describe('independent Secret Plane boundary', () => {
  it('retires the plaintext HTTP endpoint without reading its request body', async () => {
    const req = new Request('https://console.example.com/api/internal/gateway/credential', {
      method: 'POST',
      body: '{"credential_id":"canary"}',
    })
    const result = await POST(req)
    expect(result.status).toBe(410)
    expect(req.bodyUsed).toBe(false)
    expect(await result.text()).not.toContain('canary')
  })
  it('allows opaque-only production configuration without a wrapping key', () => {
    expect(loadEnv(production).kmsProvider).toBe('vault')
  })
  it('refuses old wrapping keys and all local-production bypasses', async () => {
    expect(() => loadEnv({ ...production, UPSTREAM_ENCRYPTION_KEY: 'legacy'.repeat(10) })).toThrow(/Control Plane/)
    expect(() => loadEnv({ ...production, KMS_PROVIDER: 'local', ALLOW_LOCAL_KMS_IN_PRODUCTION: 'true' })).toThrow()
    await expect(
      resolveKmsClient({
        provider: 'local',
        isProduction: true,
        masterKey: 'legacy'.repeat(10),
        featureFlags: new Set(['kms.local.allow_in_production']),
      }),
    ).rejects.toMatchObject({ code: 'kms_local_in_production' })
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => new LocalKms('legacy'.repeat(10))).toThrow()
  })
  it('rejects crypto identities mounted into Control Plane', () => {
    for (const key of ['VAULT_TOKEN', 'VAULT_TOKEN_FILE', 'SECRET_REGISTRY_SIGNING_KEY_FILE']) {
      expect(() => loadEnv({ ...production, [key]: 'forbidden' })).toThrow(/Control Plane/)
    }
  })
})
