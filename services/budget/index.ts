import 'dotenv/config'
import { Pool } from 'pg'
import { createBudgetServer } from './server'
import { Logger } from '../../packages/observability/logger'

const token = process.env.BUDGET_SERVICE_TOKEN ?? ''
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
if (token === process.env.GATEWAY_INTERNAL_TOKEN) throw new Error('Budget and Control Plane tokens must differ')
const port = Number(process.env.BUDGET_PORT ?? '8081')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BUDGET_PORT must be a valid port')
if (token.length < 24) throw new Error('BUDGET_SERVICE_TOKEN must be at least 24 characters')
if (process.argv.includes('--healthcheck')) {
  const host = process.env.BUDGET_HOST || '127.0.0.1'
  const probeHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  void fetch(`http://${probeHost.includes(':') ? `[${probeHost}]` : probeHost}:${port}/readyz`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  })
    .then((response) => {
      if (response.status !== 200) process.exitCode = 1
    })
    .catch(() => {
      process.exitCode = 1
    })
} else {
  const logger = new Logger({ service: 'budget' })
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 16, connectionTimeoutMillis: 2000 }).on(
    'error',
    () => {
      // pg removes the failed idle client before this event. Retain the service
      // for new explicit work without logging the Error/client or retrying SQL.
      logger.error('Idle database connection lost', { error_kind: 'database_idle_connection_lost' })
    },
  )
  const server = createBudgetServer(pool, token)
  server.listen(port, process.env.BUDGET_HOST ?? '127.0.0.1', () =>
    console.log('[budget] private authorization listener ready'),
  )
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () =>
      server.close(() => {
        void pool.end()
      }),
    )
  }
}
