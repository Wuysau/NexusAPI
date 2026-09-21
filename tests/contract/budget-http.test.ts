import { describe, expect, it, vi } from 'vitest'
import { createBudgetServer } from '../../services/budget/server'
import type { Pool } from 'pg'

vi.mock('@/db', () => ({ pool: {} }))

describe('private budget HTTP boundary', () => {
  it('rejects missing/wrong auth and oversized input before database access', async () => {
    const pool = new Proxy(
      {},
      {
        get() {
          throw new Error('unexpected database access')
        },
      },
    ) as Pool
    const token = 'fixture-budget-token-distinct-0123456789'
    const server = createBudgetServer(pool, token)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}/v1/reservations`
    try {
      expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401)
      expect(
        (await fetch(url, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status,
      ).toBe(401)
      expect(
        (await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'bad' })).status,
      ).toBe(400)
      expect(
        (await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'x'.repeat(17000) }))
          .status,
      ).toBe(413)
      expect((await fetch(url, { method: 'GET' })).status).toBe(404)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    }
  })
  it('refuses a missing or weak service token at startup', () => {
    expect(() => createBudgetServer({} as Pool, '')).toThrow()
    expect(() => createBudgetServer({} as Pool, 'short')).toThrow()
  })
})
