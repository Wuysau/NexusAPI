import pg from 'pg'
import { pathToFileURL } from 'node:url'
import { runMigrations } from './db-migrate.mjs'
import { assertFixtureDatabase } from './fixture-database.mjs'

// This explicit disposable database is separate from the Budget/Worker replay
// database. Never point this helper at the developer's application database.
export async function prepareProjectGatewayFixture() {
  const supplied = process.env.GATEWAY_BUDGET_INTEGRATION_DATABASE_URL || ''
  const source = new URL(supplied)
  if (
    source.protocol !== 'postgresql:' ||
    source.hostname !== '127.0.0.1' ||
    source.port !== '55439' ||
    source.pathname !== '/convergence_gateway27' ||
    supplied.includes('?') ||
    supplied.includes('#')
  )
    throw new Error('Explicit Gateway service fixture required')
  const adminURL = new URL(source)
  adminURL.pathname = '/postgres'
  const admin = new pg.Client({ connectionString: adminURL.href })
  await admin.connect()
  try {
    await assertFixtureDatabase(admin, adminURL)
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', ['convergence_gateway18'])).rowCount)
      await admin.query('CREATE DATABASE convergence_gateway18')
  } finally {
    await admin.end()
  }
  const target = new URL(source)
  target.pathname = '/convergence_gateway18'
  const pool = new pg.Pool({ connectionString: target.href })
  try {
    await assertFixtureDatabase(pool, target)
    if (
      (
        await pool.query(
          'SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
        )
      ).rows[0].n !== 0
    )
      throw new Error('Project Gateway fixture has active owners')
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await runMigrations(pool)
  } finally {
    await pool.end()
  }
  console.log('Canonical schema prepared in disposable convergence_gateway18')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await prepareProjectGatewayFixture()
