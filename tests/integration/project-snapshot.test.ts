import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { canonicalJson } from '@/lib/catalog/snapshot'
import { buildKeyring } from '@/lib/crypto'
import { pool as appPool } from '@/db'
import { GET } from '@/app/api/internal/gateway/snapshot/route'

if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const token = 'project-snapshot-internal-test-token'
const signing = 'project-snapshot-signing-test-key'
beforeAll(async () => {
  process.env.GATEWAY_INTERNAL_TOKEN = token
  process.env.SNAPSHOT_SIGNING_KEY = signing
  process.env.SNAPSHOT_SIGNING_KEY_VERSION = '1'
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
})
beforeEach(async () => {
  await pool.query(`TRUNCATE organizations,providers,gateway_snapshots CASCADE;
    INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('oa','ta','A','a'),('ob','tb','B','b');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('pa','ta','oa','Project A'),('pb','tb','ob','Project B');
    INSERT INTO downstream_api_keys(id,tenant_id,organization_id,name,hash,prefix,project_id,created_by) VALUES ('ka','ta','oa','Shared','hash-a','test','pa','creator-is-not-caller');
    INSERT INTO providers(id,code,name,official_base_url,auth_scheme) VALUES ('pr','test','Provider','https://example.invalid','bearer');
    INSERT INTO provider_credentials(id,provider_id,tenant_id,organization_id,name,encrypted_secret) VALUES ('ca','pr','ta','oa','Credential A','fixture'),('cb','pr','tb','ob','Credential B','fixture');
    INSERT INTO owned_connections(id,tenant_id,provider,mode,status) VALUES ('cona','ta','test','byok','active'),('conb','tb','test','byok','active');
    INSERT INTO channels(id,tenant_id,provider_id,provider_credential_id,name,metadata) VALUES ('cha','ta','pr','ca','Channel','{"connection_id":"cona"}');
    INSERT INTO gateway_snapshots(id,sequence_number,signature,signing_key_id,payload) VALUES ('snapshot',1,'test','hmac-sha256:v1','{}')`)
})
afterAll(async () => {
  await pool.end()
  await appPool.end()
})
const snapshot = () =>
  GET(
    new Request('http://localhost/api/internal/gateway/snapshot?tenant_id=ta', {
      headers: { authorization: `Bearer ${token}` },
    }),
  )
it('never publishes a subscription connection as a Gateway routing candidate', async () => {
  await pool.query(`INSERT INTO owned_connections(id,tenant_id,provider,mode,status,capabilities)
    VALUES('subscription','ta','test','subscription_interactive','active','{"connection_type":"subscription","execution_mode":"interactive","routing":false}');
    UPDATE channels SET metadata='{"connection_id":"subscription"}' WHERE id='cha'`)
  const response = await snapshot()
  expect(response.status).toBe(200)
  expect((await response.json()).bundle.channels).toEqual([])
  await expect(
    pool.query("UPDATE owned_connections SET credential_ref='forbidden' WHERE id='subscription'"),
  ).rejects.toThrow()
  await expect(pool.query("UPDATE owned_connections SET mode='direct_api' WHERE id='subscription'")).rejects.toThrow()
})
it('signs tenant-validated shared key project snapshots and owned connection IDs', async () => {
  const response = await snapshot()
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.bundle.keys[0]).toMatchObject({
    project_id: 'pa',
    project_name: 'Project A',
    key_kind: 'shared',
    principal_id: null,
    attribution_status: 'attributed',
  })
  expect(body.bundle.channels[0].connection_id).toBe('cona')
  expect(body.signature).toBe(
    createHmac('sha256', buildKeyring({ upstreamEncryptionKey: signing }).current.key)
      .update(canonicalJson(body.bundle))
      .digest('hex'),
  )
  await pool.query("UPDATE projects SET name='Renamed' WHERE id='pa'")
  expect((await (await snapshot()).json()).bundle.keys[0].project_name).toBe('Renamed')
  expect(body.bundle.keys[0].project_name).toBe('Project A')
})
it.each(['org', 'project', 'credential', 'connection'])('refuses signing cross-tenant %s scope', async (kind) => {
  if (kind === 'org') await pool.query("UPDATE downstream_api_keys SET organization_id='ob' WHERE id='ka'")
  if (kind === 'project') await pool.query("UPDATE downstream_api_keys SET project_id='pb' WHERE id='ka'")
  if (kind === 'credential') await pool.query("UPDATE channels SET provider_credential_id='cb' WHERE id='cha'")
  if (kind === 'connection')
    await pool.query('UPDATE channels SET metadata=\'{"connection_id":"conb"}\' WHERE id=\'cha\'')
  const response = await snapshot()
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain('signature')
})
it('marks archived project unknown and disables key, but preserves explicit no-project keys', async () => {
  await pool.query("UPDATE projects SET archived_at=now(),status='archived' WHERE id='pa'")
  expect((await (await snapshot()).json()).bundle.keys[0]).toMatchObject({
    project_id: null,
    project_name: null,
    attribution_status: 'unknown',
    enabled: false,
  })
  await pool.query("UPDATE downstream_api_keys SET project_id=NULL WHERE id='ka'")
  expect((await (await snapshot()).json()).bundle.keys[0]).toMatchObject({
    project_id: null,
    project_name: null,
    attribution_status: 'unattributed',
    enabled: true,
  })
})
it.each(['{"connection_id":""}', '{"connection_id":42}', '{"connection_id":null}', '{"connection_id":"missing"}'])(
  'refuses malformed or missing explicit connection %s',
  async (metadata) => {
    await pool.query("UPDATE channels SET metadata=$1::jsonb WHERE id='cha'", [metadata])
    expect((await snapshot()).status).toBe(500)
  },
)
it('keeps absent connection field compatible with old snapshots', async () => {
  await pool.query("UPDATE channels SET metadata='{}' WHERE id='cha'")
  expect((await (await snapshot()).json()).bundle.channels[0].connection_id).toBeNull()
})
