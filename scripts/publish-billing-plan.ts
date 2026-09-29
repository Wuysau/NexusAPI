// Operator command: no automatic env-file loading and no processor calls.
// DATABASE_URL must be deliberately provided for the intended control DB.
import { readFile } from 'node:fs/promises'
import type { PublishPlanVersionInput } from '../src/lib/plans'
import { microsToMinorUnits } from '../src/lib/payments/stripe'
import { toMicros } from '../src/lib/money'

async function main() {
  const args = process.argv.slice(2)
  if (!args.length || args.includes('--help')) {
    console.log(
      'Usage: npx tsx scripts/publish-billing-plan.ts <plan.json> [--publish]\nWithout --publish: validate and preview only. DATABASE_URL must be explicitly set to publish. See docs/operations/stripe-payments.md.',
    )
    return
  }
  if (args.length > 2 || (args[1] && args[1] !== '--publish')) throw new Error('Use <plan.json> [--publish].')
  const body = JSON.parse(await readFile(args[0], 'utf8')) as Record<string, unknown>
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Plan file must be an object.')
  const allowed = new Set(['code', 'name', 'description', 'tier', 'currency', 'price', 'interval', 'entitlements'])
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error('Plan contains unknown fields.')
  if (
    typeof body.code !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(body.code) ||
    typeof body.name !== 'string' ||
    !body.name.trim()
  )
    throw new Error('Provide a stable plan code and display name.')
  if (typeof body.price !== 'string' || !/^\d+(\.\d{1,6})?$/.test(body.price) || typeof body.currency !== 'string')
    throw new Error('Provide exact decimal price string and uppercase currency.')
  if (body.interval !== 'month' && body.interval !== 'year') throw new Error('interval must be month or year.')
  for (const key of ['description', 'tier'])
    if (body[key] !== undefined && typeof body[key] !== 'string') throw new Error(`${key} must be a string.`)
  const priceMicros = toMicros(body.price)
  microsToMinorUnits(priceMicros, body.currency)
  if (!Array.isArray(body.entitlements)) throw new Error('Provide an explicit entitlements array.')
  const seen = new Set<string>()
  const entitlements: PublishPlanVersionInput['entitlements'] = body.entitlements.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid entitlement.')
    const entry = value as Record<string, unknown>
    if (
      Object.keys(entry).some((key) => !['key', 'kind', 'value', 'description'].includes(key)) ||
      typeof entry.key !== 'string' ||
      !['members', 'api_keys', 'byok_channels', 'audit_retention_days', 'advanced_routing', 'managed_credits'].includes(
        entry.key,
      ) ||
      seen.has(entry.key)
    )
      throw new Error('Unknown or duplicate entitlement key.')
    seen.add(entry.key)
    if (entry.description !== undefined && typeof entry.description !== 'string')
      throw new Error('Entitlement description must be a string.')
    const common = { key: entry.key, description: entry.description as string | undefined }
    if (entry.kind === 'boolean' && typeof entry.value === 'boolean')
      return { ...common, kind: 'boolean', booleanValue: entry.value }
    if (
      entry.kind === 'limit' &&
      typeof entry.value === 'string' &&
      /^\d+$/.test(entry.value) &&
      BigInt(entry.value) <= 9_223_372_036_854_775_807n
    )
      return { ...common, kind: 'limit', limitValue: BigInt(entry.value) }
    throw new Error('Entitlement requires boolean value or nonnegative integer limit string.')
  })
  const preview = {
    code: body.code,
    name: body.name,
    currency: body.currency,
    price: body.price,
    interval: body.interval,
    entitlements: body.entitlements,
  }
  if (args[1] !== '--publish') {
    console.log(JSON.stringify({ preview, published: false }, null, 2))
    return
  }
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL explicitly before publishing.')
  const { pool } = await import('../src/db')
  const { createPlan, publishPlanVersion } = await import('../src/lib/plans')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`publish-plan-code:${body.code}`])
    const existing = await client.query<{ id: string }>('SELECT id FROM plans WHERE code=$1', [body.code])
    const planId =
      existing.rows[0]?.id ??
      (
        await createPlan(
          {
            code: body.code,
            name: body.name,
            description: body.description as string | undefined,
            tier: body.tier as string | undefined,
          },
          client,
        )
      ).id
    const version = await publishPlanVersion(
      { planId, currency: body.currency, priceMicros, billingInterval: body.interval, entitlements },
      client,
    )
    await client.query('COMMIT')
    console.log(
      JSON.stringify(
        { published: true, planId, planVersionId: version.id, version: version.version, ...preview },
        null,
        2,
      ),
    )
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}
main().catch(() => {
  console.error(
    'Plan validation or publication failed. Check the JSON schema, target database, and database operator logs. No payment was attempted.',
  )
  process.exitCode = 1
})
