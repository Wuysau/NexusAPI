import { readFileSync } from 'node:fs'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
if (!process.env.DATABASE_URL) throw new Error('Explicit disposable DATABASE_URL required')
const client = new Client({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const backfill = '../../scripts/backfill-project-attribution.mjs'
const { runMigrations } = await import(runner)
const { backfillProjectAttribution } = await import(backfill)
const fixture = JSON.parse(readFileSync('tests/contract/fixtures/usage-event-v2.json', 'utf8'))[0].event
beforeAll(async () => {
  await client.connect()
  await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const migrationPool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await runMigrations(migrationPool)
  } finally {
    await migrationPool.end()
  }
  await client.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('o','t','Org','backfill');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('p','t','o','Current name');
    INSERT INTO downstream_api_keys(id,tenant_id,organization_id,name,hash,prefix,project_id) VALUES ('k','t','o','Key','testhash','test','p')`)
  for (const id of ['valid', 'missing', 'conflict', 'invalid', 'unattributed', 'malformed'])
    await client.query(
      "INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind,downstream_key_id) VALUES($1,'t','o','alias','byok','k')",
      [id],
    )
  for (const [id, seq] of [
    ['valid', 1],
    ['valid', 2],
    ['conflict', 1],
    ['conflict', 2],
    ['invalid', 1],
    ['unattributed', 1],
  ] as const) {
    const event = structuredClone(fixture)
    Object.assign(event, {
      request_id: id,
      tenant_id: 't',
      organization_id: id === 'invalid' ? 'wrong' : 'o',
      event_id: `project-backfill-${id}-${seq}`,
    })
    Object.assign(event.attribution, {
      project_id: id === 'unattributed' ? null : 'p',
      project_name: id === 'conflict' && seq === 2 ? 'Conflicting history' : 'Historical name',
      api_key_id: 'k',
      connection_id: null,
      credential_id: null,
      channel_id: null,
      attribution_status: id === 'unattributed' ? 'unattributed' : 'attributed',
    })
    if (id === 'unattributed') event.attribution.project_name = null
    await client.query(
      "INSERT INTO usage_events(tenant_id,request_id,event_id,event_type,payload) VALUES('t',$1,$2,'request_completed',$3)",
      [id, event.event_id, event],
    )
  }
  await client.query(
    "INSERT INTO usage_events(tenant_id,request_id,event_id,event_type,payload) VALUES('t','malformed','malformed-event','request_completed','null'::jsonb)",
  )
})
afterAll(async () => {
  await client.end()
})
it('backfills only consistent canonical request-time evidence and preserves history on replay', async () => {
  expect(await backfillProjectAttribution(client, 't')).toEqual({
    valid: 2,
    null: 1,
    ambiguous: 3,
    existing: 0,
    inserted: 2,
  })
  const fact = (await client.query("SELECT * FROM request_project_facts WHERE request_id='valid'")).rows[0]
  expect(fact.project_name).toBe('Historical name')
  expect(fact.evidence_source).toMatch(/^usage_event:/)
  expect(fact.evidence_digest).toMatch(/^[a-f0-9]{64}$/)
  await client.query("UPDATE projects SET name='Renamed' WHERE id='p'")
  expect(await backfillProjectAttribution(client, 't')).toEqual({
    valid: 0,
    null: 1,
    ambiguous: 3,
    existing: 2,
    inserted: 0,
  })
  expect((await client.query("SELECT * FROM request_project_facts WHERE request_id='valid'")).rows[0]).toEqual(fact)
})
