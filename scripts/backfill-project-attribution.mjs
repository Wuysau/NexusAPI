import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { createRequire } from 'node:module'
import 'tsx/cjs'

const { validateUsageEventV2 } = createRequire(import.meta.url)('../packages/contracts/usage-event-v2.ts')
const dimensions = [
  'project_id',
  'project_name',
  'api_key_id',
  'principal_id',
  'key_kind',
  'connection_id',
  'credential_id',
  'channel_id',
  'execution_mode',
  'attribution_status',
]
const routing = [
  'provider_id',
  'requested_model',
  'resolved_model',
  'model_id',
  'streaming',
  'price_version_id',
  'catalog_version_id',
  'policy_version_id',
]

// Only persisted, fully valid v2 evidence is eligible. This does not independently
// authenticate its historical producer: operators must use a trusted database export.
// Current key/project/connection bindings are never used to infer historical values.
export async function backfillProjectAttribution(client, tenantId) {
  if (typeof tenantId !== 'string' || !tenantId) throw new Error('Explicit tenant required')
  const counts = { valid: 0, null: 0, ambiguous: 0, existing: 0, inserted: 0 }
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  try {
    const requests = (
      await client.query('SELECT * FROM request_records WHERE tenant_id=$1 ORDER BY id FOR UPDATE', [tenantId])
    ).rows
    for (const request of requests) {
      if (
        (
          await client.query('SELECT 1 FROM request_project_facts WHERE tenant_id=$1 AND request_id=$2', [
            tenantId,
            request.id,
          ])
        ).rowCount
      ) {
        counts.existing++
        continue
      }
      const events = (
        await client.query(
          'SELECT id,event_id,payload FROM usage_events WHERE tenant_id=$1 AND request_id=$2 ORDER BY id',
          [tenantId, request.id],
        )
      ).rows
      const candidates = []
      let invalid = false
      for (const event of events) {
        const p = event.payload
        if (p === null || typeof p !== 'object' || Array.isArray(p)) {
          invalid = true
          continue
        }
        if (p.schema_version !== 2) continue
        if (
          !validateUsageEventV2(p).ok ||
          p.tenant_id !== tenantId ||
          p.request_id !== request.id ||
          p.organization_id !== request.organization_id ||
          p.event_id !== event.event_id
        ) {
          invalid = true
          continue
        }
        candidates.push({ event, values: [...dimensions.map((k) => p.attribution[k]), ...routing.map((k) => p[k])] })
      }
      if (invalid || new Set(candidates.map((c) => JSON.stringify(c.values))).size > 1) {
        counts.ambiguous++
        continue
      }
      if (!candidates.length) {
        counts.null++
        continue
      }
      const { event, values } = candidates[0]
      if (event.payload.attribution.attribution_status === 'unknown') {
        counts.null++
        continue
      }
      await client.query('SAVEPOINT attribution_insert')
      try {
        const fields = [
          'request_id',
          'tenant_id',
          'organization_id',
          ...dimensions,
          ...routing,
          'evidence_source',
          'evidence_digest',
        ]
        const args = [
          request.id,
          tenantId,
          request.organization_id,
          ...values,
          `usage_event:${event.id}`,
          createHash('sha256').update(JSON.stringify(event.payload)).digest('hex'),
        ]
        const result = await client.query(
          `INSERT INTO request_project_facts (${fields.join(',')}) VALUES (${args.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (request_id) DO NOTHING`,
          args,
        )
        counts.valid++
        counts.inserted += result.rowCount
        await client.query('RELEASE SAVEPOINT attribution_insert')
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT attribution_insert')
        await client.query('RELEASE SAVEPOINT attribution_insert')
        if (error.code !== 'P0001' && error.code !== '23503') throw error
        counts.ambiguous++
      }
    }
    await client.query('COMMIT')
    return counts
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tenantId = process.argv[2]
  if (!process.env.DATABASE_URL || !tenantId) throw new Error('DATABASE_URL and tenant argument required')
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  try {
    await client.connect()
    console.log(JSON.stringify(await backfillProjectAttribution(client, tenantId)))
  } catch {
    console.error('Project attribution backfill refused; transaction rolled back.')
    process.exitCode = 1
  } finally {
    await client.end()
  }
}
