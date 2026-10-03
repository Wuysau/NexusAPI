import pg from 'pg'
import { runMigrations } from './db-migrate.mjs'
import { connectorTestDatabaseURL, healthRecoveryDatabaseURL, assertFixtureDatabase } from './fixture-database.mjs'
const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit fixture DATABASE_URL required')
const source = new URL(supplied)
if (
  !['postgres:', 'postgresql:'].includes(source.protocol) ||
  !['127.0.0.1', 'localhost'].includes(source.hostname) ||
  source.search ||
  source.hash
)
  throw new Error('CI fixtures require an unambiguous loopback database')
if (!/^\/convergence_ci\d+$/.test(source.pathname)) throw new Error('Named disposable convergence_ci database required')
const connectorURL = connectorTestDatabaseURL(process.env.CONNECTOR_TEST_DATABASE_URL)
const healthURL = healthRecoveryDatabaseURL(process.env.GATEWAY_HEALTH_RECOVERY_DATABASE_URL)
if (connectorURL.host !== source.host || healthURL.host !== source.host)
  throw new Error('CI fixture databases must use the same local PostgreSQL instance')
const adminURL = new URL(source)
adminURL.pathname = '/postgres'
const admin = new pg.Client({ connectionString: adminURL.href })
await admin.connect()
try {
  await assertFixtureDatabase(admin, adminURL)
  for (const name of [
    'convergence_e2e15',
    'convergence_gateway27',
    connectorURL.pathname.slice(1),
    healthURL.pathname.slice(1),
  ]) {
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount)
      await admin.query(`CREATE DATABASE "${name}"`)
    const url =
      name === connectorURL.pathname.slice(1)
        ? connectorURL
        : name === healthURL.pathname.slice(1)
          ? healthURL
          : new URL(source)
    url.pathname = `/${name}`
    const pool = new pg.Pool({ connectionString: url.href })
    try {
      await assertFixtureDatabase(pool, url)
      if (
        name === healthURL.pathname.slice(1) &&
        (
          await pool.query(
            'SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
          )
        ).rows[0].n !== 0
      )
        throw new Error('Storage recovery fixture has active owners')
      await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
      await runMigrations(pool)
    } finally {
      await pool.end()
    }
  }
  const pool = new pg.Pool({ connectionString: supplied })
  try {
    await assertFixtureDatabase(pool, source)
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await runMigrations(pool)
  } finally {
    await pool.end()
  }
  console.log('Canonical migrations applied to five isolated CI fixture databases')
} finally {
  await admin.end()
}
