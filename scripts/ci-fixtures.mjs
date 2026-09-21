import pg from 'pg'
import { runMigrations } from './db-migrate.mjs'
const supplied = process.env.DATABASE_URL
if (!supplied) throw new Error('Explicit fixture DATABASE_URL required')
const source = new URL(supplied)
if (!['127.0.0.1', 'localhost'].includes(source.hostname)) throw new Error('CI fixtures require loopback database')
if (!/^\/convergence_ci\d+$/.test(source.pathname)) throw new Error('Named disposable convergence_ci database required')
const adminURL = new URL(source)
adminURL.pathname = '/postgres'
const admin = new pg.Client({ connectionString: adminURL.href })
await admin.connect()
try {
  for (const name of ['convergence_e2e15', 'convergence_gateway27']) {
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount)
      await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(source)
    url.pathname = `/${name}`
    const pool = new pg.Pool({ connectionString: url.href })
    try {
      await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
      await runMigrations(pool)
    } finally {
      await pool.end()
    }
  }
  const pool = new pg.Pool({ connectionString: supplied })
  try {
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await runMigrations(pool)
  } finally {
    await pool.end()
  }
  console.log('Canonical migrations applied to three isolated CI fixture databases')
} finally {
  await admin.end()
}
