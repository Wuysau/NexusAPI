import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Pool } from 'pg'
import { authorizeBudget, BudgetError } from './authorize'

export function createBudgetServer(pool: Pool, token: string) {
  if (token.length < 24) throw new Error('BUDGET_SERVICE_TOKEN must be at least 24 characters')
  const expected = Buffer.from(`Bearer ${token}`)
  return createServer({ requestTimeout: 6000, headersTimeout: 5000, maxHeaderSize: 8192 }, async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const readiness = req.method === 'GET' && req.url === '/readyz'
    if (!readiness && (req.method !== 'POST' || req.url !== '/v1/reservations')) {
      reply(404, { error: { code: 'not_found' } })
      return
    }
    const auth = Buffer.from(req.headers.authorization ?? '')
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      reply(401, { error: { code: 'unauthorized' } })
      return
    }
    try {
      if (readiness) {
        const query = {
          text: `SELECT bool_and(to_regclass(name) IS NOT NULL) AS ready FROM unnest($1::text[]) AS name`,
          values: [
            [
              'organizations',
              'downstream_api_keys',
              'providers',
              'provider_price_versions',
              'sale_price_snapshots',
              'sale_price_rules',
              'exchange_rate_snapshots',
              'wallet_accounts',
              'ledger_accounts',
              'ledger_transactions',
              'ledger_postings',
              'request_records',
            ],
          ],
          query_timeout: 2000,
        }
        const result = await pool.query<{ ready: boolean }>(query)
        reply(result.rows[0]?.ready === true ? 200 : 503, { ready: result.rows[0]?.ready === true })
        return
      }
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > 16384) {
          reply(413, { error: { code: 'request_too_large' } })
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        reply(400, { error: { code: 'invalid_request' } })
        return
      }
      reply(200, await authorizeBudget(pool, body))
    } catch (error) {
      // No database errors, payloads or credential material leave this boundary.
      reply(error instanceof BudgetError ? error.status : 503, {
        error: { code: error instanceof BudgetError ? error.code : 'budget_unavailable' },
      })
    }
  })
}
