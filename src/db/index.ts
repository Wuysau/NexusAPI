import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { Logger } from '../../packages/observability/logger'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool
}
const logger = new Logger({ service: 'database' })

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2000,
  }).on('error', () => {
    // pg has already removed the failed idle client. Never log its Error/client
    // (which can contain credentials), or replay previously dispatched SQL.
    logger.error('Idle database connection lost', { error_kind: 'database_idle_connection_lost' })
  })

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__arenaNextJsPostgresqlPool = pool
}

export const db = drizzle(pool)
