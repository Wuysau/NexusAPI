#!/usr/bin/env node
// Reconciliation status check.
//
// Usage: DATABASE_URL=... node scripts/ops/reconcile-check.mjs
//
// Reports: open case count, oldest open case age, total absolute variance.

import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: DATABASE_URL })

async function main() {
  try {
    const open = await pool.query(`
      SELECT count(*)::int AS n,
             coalesce(sum(abs(coalesce(actual_amount, 0) - coalesce(expected_amount, 0))), 0)::text AS variance
        FROM reconciliation_cases
       WHERE status IN ('open', 'investigating')
    `)
    const oldest = await pool.query(`
      SELECT extract(epoch from (now() - created_at))::int AS age_seconds
        FROM reconciliation_cases
       WHERE status IN ('open', 'investigating')
       ORDER BY created_at ASC
       LIMIT 1
    `)

    const n = open.rows[0]?.n ?? 0
    const variance = open.rows[0]?.variance ?? '0'
    const age = oldest.rows[0]?.age_seconds ?? null

    console.log(`Open cases: ${n}`)
    console.log(`Total absolute variance: ${variance} micros`)
    console.log(`Oldest open case age: ${age !== null ? age + 's' : 'none'}`)

    if (n > 0) {
      console.log('Action: investigate open reconciliation cases')
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('Reconciliation check failed:', err)
  process.exit(1)
})
