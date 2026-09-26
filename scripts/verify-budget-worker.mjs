// Run after TestBudgetPostgresControlPlaneOutage and starting the actual Worker.
// This fixture-only verifier intentionally refuses all other database names.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'

const url = new URL(process.env.DATABASE_URL ?? '')
assert.equal(url.hostname, '127.0.0.1')
assert.equal(url.port, '55439')
assert.equal(url.pathname, '/convergence_gateway27')
const client = new pg.Client({ connectionString: url.href })
await client.connect()
try {
  async function waitPublished() {
    const deadline = Date.now() + 30_000
    let published = 0
    do {
      const row = (await client.query("SELECT count(*)::int n FROM outbox_events WHERE status='published'")).rows[0]
      published = row.n
      if (published === 5) return
      if (Date.now() >= deadline) break
      await delay(250)
    } while (true)
    throw new Error(`Worker published ${published} of five fixture events before the deadline`)
  }
  await waitPublished()
  const requests = (
    await client.query(
      'SELECT id,channel_kind,status,input_tokens,output_tokens,charge_amount,reservation_released FROM request_records',
    )
  ).rows
  assert.equal(requests.length, 5)
  let walletCharge = 0n
  for (const request of requests) {
    assert.equal(request.status, 'completed')
    // Existing money.charge truncates each component: floor(2.5*11)+10*4 = 67 micros.
    const charge =
      request.channel_kind === 'platform'
        ? (25n * BigInt(request.input_tokens)) / 10n + 10n * BigInt(request.output_tokens)
        : 0n
    assert.equal(BigInt(request.charge_amount), charge)
    walletCharge += charge
    if (request.channel_kind === 'platform') assert.equal(request.reservation_released, true)
  }
  const counts = (await client.query('SELECT type,count(*)::int n FROM ledger_transactions GROUP BY type')).rows
  assert.equal(counts.find((row) => row.type === 'usage').n, 5)
  assert.equal(counts.find((row) => row.type === 'reservation_release').n, 3)
  const balance = (
    await client.query(
      "SELECT sum(p.amount)::text amount FROM ledger_postings p JOIN ledger_accounts a ON a.id=p.account_id WHERE a.type='wallet'",
    )
  ).rows[0].amount
  assert.equal(BigInt(balance), 1_000_000n - walletCharge)
  const postings = (await client.query('SELECT id,transaction_id,account_id,amount FROM ledger_postings ORDER BY id'))
    .rows
  await client.query("UPDATE outbox_events SET status='pending',published_at=NULL,next_attempt_at=now()")
  await waitPublished()
  assert.deepEqual(
    (await client.query('SELECT id,transaction_id,account_id,amount FROM ledger_postings ORDER BY id')).rows,
    postings,
  )
  console.log(
    `PASS: five events; managed charge ${walletCharge} micros; wallet ${balance}; three releases including late completion; replay leaves every posting unchanged`,
  )
} finally {
  await client.end()
}
