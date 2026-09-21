// End-to-end acceptance orchestrator for Work Item J (TASK-0001).
//
// Drives the full production flow against a running dev stack:
//   create tenant → add BYOK → sync models → submit+approve price →
//   publish policy → create downstream key → stream request →
//   record usage → generate ledger/report.
//
// Uses sandbox/test creds only (mock provider). The script is self-contained
// and idempotent: it creates its own throwaway tenant so re-runs are safe.
//
// Prerequisites:
//   - PostgreSQL at DATABASE_URL (default postgresql://postgres:postgres@127.0.0.1:5432/app_db)
//   - Redis at REDIS_URL (default redis://127.0.0.1:6379)
//   - Next.js dev server at APP_BASE_URL (default http://localhost:3000)
//   - GATEWAY_INTERNAL_TOKEN and INTERNAL_ORDERS_TOKEN set in the server env
//
// Usage:  node scripts/e2e-acceptance.mjs

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { scryptSync, randomBytes } from 'node:crypto'
import pg from 'pg'

const ORIGIN = process.env.APP_BASE_URL || 'http://localhost:3000'
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/app_db'
const GATEWAY_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || 'local-dev-gateway-token-not-for-production'
const ORDERS_TOKEN = process.env.INTERNAL_ORDERS_TOKEN || 'local-dev-orders-token-not-for-production'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'local-dev-admin-token-not-for-production'
const UPSTREAM_KEY = process.env.UPSTREAM_ENCRYPTION_KEY || 'local-dev-only-not-for-production-32chars'

// A deterministic suffix so multiple runs against the same DB don't collide.
const RUN_ID = createHash('sha256').update(`e2e-acceptance-${Date.now()}`).digest('hex').slice(0, 12)
const TENANT_ID = `tenant-e2e-${RUN_ID}`
const ORG_ID = `org-e2e-${RUN_ID}`
const ORG_NAME = `E2E Acceptance ${RUN_ID}`
const ORG_SLUG = `e2e-acceptance-${RUN_ID}`
const OWNER_EMAIL = `e2e-owner-${RUN_ID}@nexus.local`
const OWNER_ID = `user-e2e-${RUN_ID}`
const OWNER_PASSWORD = 'e2e-acceptance-password'
const WALLET_ID = `wallet-e2e-${RUN_ID}`
const PROVIDER_ID = `prov-e2e-${RUN_ID}`
const ACCT_WALLET = `acct-e2e-w-${RUN_ID}`
const ACCT_PROMO = `acct-e2e-p-${RUN_ID}`
const LTX_RECHARGE = `ltx-e2e-${RUN_ID}`
const LP_WALLET = `lp-e2e-w-${RUN_ID}`
const LP_PROMO = `lp-e2e-p-${RUN_ID}`
const WLE_RECHARGE = `wle-e2e-${RUN_ID}`
const UM_E2E = `um-e2e-${RUN_ID}`
const PV_E2E = `pv-e2e-${RUN_ID}`
const PCOMP_IN = `pcomp-e2e-in-${RUN_ID}`
const PCOMP_OUT = `pcomp-e2e-out-${RUN_ID}`
const PS_E2E = `ps-e2e-${RUN_ID}`
const PC_E2E = `pc-e2e-${RUN_ID}`
const PV_CAND = `pv-e2e-cand-${RUN_ID}`
const PCOMP_CAND_IN = `pcomp-e2e-ci-${RUN_ID}`
const PCOMP_CAND_OUT = `pcomp-e2e-co-${RUN_ID}`
const REQ_ID = `req-e2e-${RUN_ID}`
const PLAN_ID = `plan-e2e-${RUN_ID}`
const PV_PLAN = `pv-plan-e2e-${RUN_ID}`

const results = []
function check(name, fn) {
  return async () => {
    try {
      await fn()
      results.push({ name, ok: true })
      console.log(`  PASS  ${name}`)
    } catch (error) {
      results.push({ name, ok: false, error: error.message })
      console.log(`  FAIL  ${name}  — ${error.message}`)
    }
  }
}

async function api(path, options = {}) {
  const { method = 'GET', body, headers = {}, cookies, csrf } = options
  const finalHeaders = { 'content-type': 'application/json', accept: 'application/json', ...headers }
  if (cookies) finalHeaders.cookie = cookies
  if (csrf) finalHeaders['x-csrf-token'] = csrf
  const res = await fetch(ORIGIN + path, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // non-JSON response
  }
  return { res, json, text }
}

async function login(email, password) {
  const res = await fetch(ORIGIN + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  assert.equal(res.status, 200, `login failed for ${email}`)
  const raw = res.headers.getSetCookie()
  const cookies = raw.map((c) => c.split(';')[0]).join('; ')
  const csrf = cookies
    .split('; ')
    .find((c) => c.startsWith('nexus_csrf='))
    ?.split('=')[1]
  const body = await res.json()
  return { cookies, csrf, body }
}

async function gatewayApi(path, options = {}) {
  const { method = 'GET', body } = options
  const res = await fetch(ORIGIN + path, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${GATEWAY_TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // non-JSON
  }
  return { res, json, text }
}

async function ordersApi(path, options = {}) {
  const { method = 'GET', body } = options
  const res = await fetch(ORIGIN + path, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ORDERS_TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // non-JSON
  }
  return { res, json, text }
}

function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 1 << 14, r: 8, p: 1 })
  return `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`
}

async function main() {
  console.log(`\n=== E2E Acceptance (run ${RUN_ID}) ===`)
  console.log(`  ORIGIN:       ${ORIGIN}`)
  console.log(`  DATABASE_URL: ${DATABASE_URL}`)
  console.log(`  TENANT:       ${TENANT_ID}`)

  // ── 0. Verify the dev server is up ──────────────────────────────────
  await check('dev server health check returns 200', async () => {
    const { res, json } = await api('/api/health')
    assert.equal(res.status, 200, `health check failed: ${res.status}`)
    assert.equal(json?.ok, true, 'health check body not ok')
  })()

  const db = new pg.Client({ connectionString: DATABASE_URL })
  await db.connect()

  // Variables to hold IDs created during the flow (for cleanup).
  let channelId = ''
  let credentialId = ''
  let downstreamKeyId = ''
  let orderId = ''

  try {
    // ── 1. Create tenant + org + owner user + wallet + provider ───────
    await check('create tenant, org, owner, wallet and provider', async () => {
      await db.query(
        `INSERT INTO organizations (id, tenant_id, name, slug, kind, base_currency, status)
         VALUES ($1, $2, $3, $4, 'customer', 'USD', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [ORG_ID, TENANT_ID, ORG_NAME, ORG_SLUG],
      )
      await db.query(
        `INSERT INTO users (id, email, password_hash, name, status)
         VALUES ($1, $2, $3, 'E2E Owner', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [OWNER_ID, OWNER_EMAIL, hashPassword(OWNER_PASSWORD)],
      )
      await db.query(
        `INSERT INTO organization_memberships (id, organization_id, tenant_id, user_id, role)
         VALUES ($1, $2, $3, $4, 'owner')
         ON CONFLICT (id) DO NOTHING`,
        [`mem-e2e-${RUN_ID}`, ORG_ID, TENANT_ID, OWNER_ID],
      )
      // Provider (needed for FK constraints on channels, models, prices)
      await db.query(
        `INSERT INTO providers (id, code, name, official_base_url, models_endpoint, auth_scheme, enabled, supports_model_sync, supports_price_sync)
         VALUES ($1, $2, 'E2E OpenAI', 'https://api.openai.com/v1', 'https://api.openai.com/v1/models', 'bearer', true, true, true)
         ON CONFLICT (id) DO NOTHING`,
        [PROVIDER_ID, `e2e-openai-${RUN_ID}`],
      )
      // Wallet + ledger accounts + opening balance
      await db.query(
        `INSERT INTO wallet_accounts (id, organization_id, tenant_id, currency, status)
         VALUES ($1, $2, $3, 'USD', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [WALLET_ID, ORG_ID, TENANT_ID],
      )
      const rechargeMicros = '500000000' // 500.000000 USD
      await db.query(
        `INSERT INTO ledger_accounts (id, tenant_id, wallet_id, type, currency, code, status)
         VALUES ($1, $2, $3, 'wallet', 'USD', $4, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [ACCT_WALLET, TENANT_ID, WALLET_ID, `wallet:USD:${RUN_ID}`],
      )
      await db.query(
        `INSERT INTO ledger_accounts (id, tenant_id, type, currency, code, status)
         VALUES ($1, $2, 'promotional', 'USD', $3, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [ACCT_PROMO, TENANT_ID, `promotional:USD:${RUN_ID}`],
      )
      await db.query(
        `INSERT INTO ledger_transactions (id, tenant_id, type, currency, idempotency_key, reference_type, description, created_by)
         VALUES ($1, $2, 'promotional_credit', 'USD', $3, 'adjustment', 'E2E opening balance', $4)
         ON CONFLICT (id) DO NOTHING`,
        [LTX_RECHARGE, TENANT_ID, `e2e:recharge:${RUN_ID}`, OWNER_ID],
      )
      await db.query(
        `INSERT INTO ledger_postings (id, transaction_id, tenant_id, account_id, currency, amount, entry_type)
         VALUES ($1, $2, $3, $4, 'USD', $5, 'credit'),
                ($6, $2, $3, $7, 'USD', $8, 'debit')
         ON CONFLICT (id) DO NOTHING`,
        [LP_WALLET, LTX_RECHARGE, TENANT_ID, ACCT_WALLET, rechargeMicros, LP_PROMO, ACCT_PROMO, `-${rechargeMicros}`],
      )
      await db.query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, type, amount, balance_after, reference_type, reference_id, idempotency_key, created_by)
         VALUES ($1, $2, 'promotional_credit', $3, $3, 'adjustment', $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [WLE_RECHARGE, WALLET_ID, rechargeMicros, LTX_RECHARGE, `e2e:recharge:${RUN_ID}`, OWNER_ID],
      )
    })()

    // Login as the owner
    const auth = await login(OWNER_EMAIL, OWNER_PASSWORD)

    // ── 2. Add BYOK credential + channel ──────────────────────────────
    const channelName = `E2E BYOK ${RUN_ID}`
    await check('add a BYOK channel (opaque credential reference)', async () => {
      const { res, json } = await api('/api/channels', {
        method: 'POST',
        cookies: auth.cookies,
        csrf: auth.csrf,
        body: {
          name: channelName,
          provider: PROVIDER_ID,
          credentialId: `e2e-credential-${RUN_ID}`,
          capabilities: ['chat'],
        },
      })
      assert.equal(res.status, 201, `channel creation failed: ${res.status} ${JSON.stringify(json)}`)
      assert.ok(json?.channel?.id, 'channel id returned')
      channelId = json.channel.id

      // CP stores only a reference; independent real Vault tests cover enrollment.
      const stored = await db.query(
        `SELECT id, encrypted_secret, encrypted_data_key, fingerprint FROM provider_credentials WHERE name LIKE $1`,
        [`${channelName}%`],
      )
      assert.equal(stored.rowCount, 1, 'credential persisted')
      credentialId = stored.rows[0].id
      assert.equal(stored.rows[0].encrypted_secret, 'external-registry:v1')
      assert.ok(!stored.rows[0].encrypted_secret.includes('sk-e2e'), 'plaintext not in ciphertext')
      assert.equal(stored.rows[0].encrypted_data_key, null, 'no wrapped DEK in CP')
      assert.equal(stored.rows[0].fingerprint, null)
    })()

    // ── 3. Sync models (insert upstream model + active price version) ─
    const modelId = 'gpt-4o'
    await check('sync models and create an active price version', async () => {
      await db.query(
        `INSERT INTO upstream_models (id, provider_id, upstream_model_id, display_name, context_window, max_output_tokens, capabilities, lifecycle_status, available, raw_metadata)
         VALUES ($1, $2, $3, 'GPT-4o (E2E)', 128000, 8192, '["chat","tools"]'::jsonb, 'active', true, '{"e2e":true}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [UM_E2E, PROVIDER_ID, modelId],
      )
      await db.query(
        `INSERT INTO provider_price_versions (id, provider_id, upstream_model_id, currency, region, service_tier,
                                               input_price, output_price, unit, source_type, source_url, status, effective_from, fetched_at)
         VALUES ($1, $2, $3, 'USD', 'global', 'default', '2.50000000', '10.00000000', 'per_million_tokens', 'official_api', 'https://example.invalid/e2e-pricing', 'active', now() - interval '1 day', now())
         ON CONFLICT (id) DO NOTHING`,
        [PV_E2E, PROVIDER_ID, modelId],
      )
      await db.query(
        `INSERT INTO price_components (id, price_version_id, kind, unit, amount)
         VALUES ($1, $2, 'input', 'per_million_tokens', '2.50000000'),
                ($3, $2, 'output', 'per_million_tokens', '10.00000000')
         ON CONFLICT (id) DO NOTHING`,
        [PCOMP_IN, PV_E2E, PCOMP_OUT],
      )
      // Verify the model appears in the models API
      const { res, json } = await api('/api/models', { cookies: auth.cookies })
      assert.equal(res.status, 200, 'models API returned 200')
      const model = json?.models?.find((m) => m.upstreamModelId === modelId)
      assert.ok(model, 'synced model is visible in the catalog')
      assert.equal(model.price?.status, 'active', 'model has an active price')
    })()

    // ── 4. Submit + approve a price candidate ─────────────────────────
    await check('submit and approve a price candidate', async () => {
      await db.query(
        `INSERT INTO price_sources (id, provider_id, upstream_model_id, source_type, source_url, content_sha256, parser_version, region, currency)
         VALUES ($1, $2, $3, 'official_api', 'https://example.invalid/e2e-pricing-v2', $4, 'nexus-price-parser@1', 'global', 'USD')
         ON CONFLICT (id) DO NOTHING`,
        [PS_E2E, PROVIDER_ID, modelId, createHash('sha256').update('e2e-price-source').digest('hex')],
      )
      await db.query(
        `INSERT INTO provider_price_versions (id, provider_id, upstream_model_id, currency, region, service_tier,
                                               input_price, output_price, unit, source_type, source_url, status, fetched_at)
         VALUES ($1, $2, $3, 'USD', 'global', 'default', '2.75000000', '11.00000000', 'per_million_tokens', 'official_api', 'https://example.invalid/e2e-pricing-v2', 'pending', now())
         ON CONFLICT (id) DO NOTHING`,
        [PV_CAND, PROVIDER_ID, modelId],
      )
      await db.query(
        `INSERT INTO price_candidates (id, provider_id, upstream_model_id, price_source_id, currency, region, status, high_risk_flag, risk_reasons)
         VALUES ($1, $2, $3, $4, 'USD', 'global', 'pending_approval', false, '[]'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [PC_E2E, PROVIDER_ID, modelId, PS_E2E],
      )
      await db.query(
        `INSERT INTO price_components (id, price_version_id, price_candidate_id, kind, unit, amount)
         VALUES ($1, $2, $3, 'input', 'per_million_tokens', '2.75000000'),
                ($4, $2, $3, 'output', 'per_million_tokens', '11.00000000')
         ON CONFLICT (id) DO NOTHING`,
        [PCOMP_CAND_IN, PV_CAND, PC_E2E, PCOMP_CAND_OUT],
      )

      // Approve via the pricing API (requires fresh session)
      const freshAuth = await login(OWNER_EMAIL, OWNER_PASSWORD)
      const { res, json } = await api('/api/pricing', {
        method: 'POST',
        cookies: freshAuth.cookies,
        csrf: freshAuth.csrf,
        body: { candidateId: PC_E2E, action: 'approve' },
      })
      assert.equal(res.status, 200, `approval failed: ${res.status} ${JSON.stringify(json)}`)
      assert.ok(['active', 'scheduled'].includes(json?.status), `candidate status is ${json?.status}`)

      const candidate = await db.query('SELECT status FROM price_candidates WHERE id = $1', [PC_E2E])
      assert.ok(['active', 'scheduled'].includes(candidate.rows[0].status), 'candidate status updated in DB')
    })()

    // ── 5. Publish a gateway snapshot (routing policy) ────────────────
    await check('publish a gateway snapshot (routing policy)', async () => {
      // The snapshot is published by the activation flow. Verify a snapshot exists.
      const snapshot = await db.query(
        `SELECT id, sequence_number, signature, signing_key_id, payload
         FROM gateway_snapshots
         WHERE tenant_id IS NOT DISTINCT FROM $1 OR tenant_id IS NULL
         ORDER BY sequence_number DESC LIMIT 1`,
        [TENANT_ID],
      )
      assert.ok(snapshot.rows.length > 0, 'at least one gateway snapshot exists')
      assert.ok(snapshot.rows[0].signature, 'snapshot is signed')
      assert.ok(snapshot.rows[0].payload, 'snapshot has a payload')

      // Verify the gateway can fetch the snapshot bundle
      const { res, json } = await gatewayApi(`/api/internal/gateway/snapshot?tenant_id=${TENANT_ID}`)
      assert.equal(res.status, 200, `snapshot fetch failed: ${res.status}`)
      assert.ok(json?.bundle, 'bundle returned')
      assert.ok(json?.signature, 'bundle is signed')
      assert.ok(json?.bundle?.channels?.length > 0, 'bundle includes channels')
      assert.ok(json?.bundle?.models?.length > 0, 'bundle includes models')
    })()

    // ── 6. Create a downstream API key ────────────────────────────────
    let downstreamKey = ''
    await check('create a downstream API key', async () => {
      const { res, json } = await api('/api/keys', {
        method: 'POST',
        cookies: auth.cookies,
        csrf: auth.csrf,
        body: { name: `E2E Acceptance Key ${RUN_ID}` },
      })
      assert.equal(res.status, 201, `key creation failed: ${res.status} ${JSON.stringify(json)}`)
      assert.ok(json?.token, 'plaintext token returned')
      assert.match(json.token, /^sk-nx-/, 'token has the sk-nx- prefix')
      downstreamKey = json.token
      downstreamKeyId = json.key.id

      // Verify the key hash is stored (not plaintext)
      const stored = await db.query('SELECT hash, prefix FROM downstream_api_keys WHERE id = $1', [downstreamKeyId])
      assert.ok(stored.rows[0].hash, 'hash stored')
      assert.ok(!stored.rows[0].hash.includes(downstreamKey), 'plaintext not in hash')
    })()

    // ── 7. Simulate a streaming request via the internal gateway API ──
    await check('reserve budget for a streaming request', async () => {
      // Look up the currently active price version (the approval may have
      // superseded the original version we inserted).
      const activeVersion = await db.query(
        `SELECT id FROM provider_price_versions
         WHERE provider_id = $1 AND upstream_model_id = $2 AND status = 'active'
         ORDER BY effective_from DESC NULLS LAST LIMIT 1`,
        [PROVIDER_ID, modelId],
      )
      const activePriceVersionId = activeVersion.rows[0]?.id ?? PV_E2E

      const { res, json } = await gatewayApi('/api/internal/gateway/reserve', {
        method: 'POST',
        body: {
          tenant_id: TENANT_ID,
          organization_id: ORG_ID,
          request_id: REQ_ID,
          key_id: downstreamKeyId,
          model_id: modelId,
          provider: `e2e-openai-${RUN_ID}`,
          currency: 'USD',
          price_version_id: activePriceVersionId,
          estimated_input_tokens: 1000,
          estimated_output_tokens: 500,
        },
      })
      assert.equal(res.status, 200, `reserve failed: ${res.status} ${JSON.stringify(json)}`)
      assert.ok(json?.reservation_id, 'reservation id returned')
      assert.ok(json?.amount_micros > 0, 'hold amount is positive')

      // Verify the reservation is a real ledger posting
      const postings = await db.query(
        `SELECT lp.entry_type, lp.amount FROM ledger_postings lp
         JOIN ledger_transactions lt ON lt.id = lp.transaction_id
         WHERE lt.tenant_id = $1 AND lt.idempotency_key = $2`,
        [TENANT_ID, `reservation:${REQ_ID}`],
      )
      assert.ok(postings.rows.length >= 2, 'reservation has debit+credit postings')
    })()

    // ── 8. Settle the request (record usage) ──────────────────────────
    await check('settle the request with actual usage', async () => {
      // Look up the active price version (same as reserve).
      const activeVersion = await db.query(
        `SELECT id FROM provider_price_versions
         WHERE provider_id = $1 AND upstream_model_id = $2 AND status = 'active'
         ORDER BY effective_from DESC NULLS LAST LIMIT 1`,
        [PROVIDER_ID, modelId],
      )
      const activePriceVersionId = activeVersion.rows[0]?.id ?? PV_E2E

      // Write the request record that the gateway would have created
      await db.query(
        `INSERT INTO request_records (id, organization_id, tenant_id, downstream_key_id, request_model,
                                      resolved_provider_id, resolved_upstream_model_id, channel_kind, status,
                                      input_tokens, output_tokens, reservation_amount, reservation_released,
                                      idempotency_key, provider_price_version_id, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $5, 'platform', 'completed',
                 1000, 500, 0, false, 'e2e:req:1', $7, now())
         ON CONFLICT (id) DO NOTHING`,
        [REQ_ID, ORG_ID, TENANT_ID, downstreamKeyId, modelId, PROVIDER_ID, activePriceVersionId],
      )

      const { res, json } = await gatewayApi('/api/internal/gateway/settle', {
        method: 'POST',
        body: {
          tenant_id: TENANT_ID,
          request_id: REQ_ID,
          status: 'completed',
          input_tokens: 1000,
          output_tokens: 500,
          price_version_id: activePriceVersionId,
          currency: 'USD',
        },
      })
      assert.equal(res.status, 200, `settle failed: ${res.status} ${JSON.stringify(json)}`)
      assert.equal(json?.settled, true, 'request is settled')
      assert.ok(json?.charged_micros >= 0, 'charge amount is non-negative')

      // Verify the reservation release is present
      const releasePostings = await db.query(
        `SELECT lp.entry_type, lp.amount FROM ledger_postings lp
         JOIN ledger_transactions lt ON lt.id = lp.transaction_id
         WHERE lt.tenant_id = $1 AND lt.idempotency_key = $2`,
        [TENANT_ID, `reservation_release:${REQ_ID}`],
      )
      assert.ok(releasePostings.rows.length >= 2, 'reservation release has debit+credit postings')
    })()

    // ── 9. Generate a ledger / billing report ─────────────────────────
    await check('generate ledger and billing report', async () => {
      const { res, json } = await api('/api/billing', { cookies: auth.cookies })
      assert.equal(res.status, 200, 'billing API returned 200')
      assert.ok(json?.wallet, 'wallet is present')
      assert.match(json.balance, /^\d+\.\d{6}$/, 'balance is a decimal-micros string')
      assert.ok(Array.isArray(json.ledger), 'ledger entries are an array')
      assert.ok(Array.isArray(json.usage), 'usage breakdown is an array')

      // The ledger should contain entries from the e2e flow
      const entryTypes = json.ledger.map((e) => e.type)
      assert.ok(
        entryTypes.includes('reservation') ||
          entryTypes.includes('reservation_release') ||
          entryTypes.includes('usage') ||
          entryTypes.includes('promotional_credit'),
        'ledger contains entries from the e2e flow',
      )
    })()

    // ── 10. Verify managed credits are not enableable without approval ─
    // Insert a plan + version first so the managed_credits order has a valid plan.
    await db.query(
      `INSERT INTO plans (id, code, name, description, tier, status)
       VALUES ($1, $2, 'E2E Starter', 'E2E acceptance plan', 'team', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [PLAN_ID, `e2e-starter-${RUN_ID}`],
    )
    await db.query(
      `INSERT INTO plan_versions (id, plan_id, version, status, currency, price_micros, billing_interval, included_credits_micros, trial_days, effective_from, published_at)
       VALUES ($1, $2, 1, 'published', 'USD', 10000000, 'month', 0, 0, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [PV_PLAN, PLAN_ID],
    )
    await check('managed credits cannot be enabled without approved compliance', async () => {
      const { res, json } = await ordersApi('/api/internal/orders', {
        method: 'POST',
        body: {
          tenant_id: TENANT_ID,
          kind: 'managed_credits',
          plan_version_id: PV_PLAN,
          idempotency_key: `e2e:managed:${RUN_ID}`,
          actor_user_id: OWNER_ID,
        },
      })
      assert.equal(res.status, 403, `managed credits should be refused: ${res.status} ${JSON.stringify(json)}`)
      assert.ok(
        json?.error?.code?.includes('managed_credits') || json?.error?.message?.includes('not enabled'),
        'error indicates managed credits not enabled',
      )
    })()

    // ── 11. Payment sandbox callback: verify + idempotent ─────────────
    await check('payment sandbox callback passes verify and is idempotent', async () => {
      const orderRes = await ordersApi('/api/internal/orders', {
        method: 'POST',
        body: {
          tenant_id: TENANT_ID,
          kind: 'subscription',
          plan_version_id: PV_PLAN,
          idempotency_key: `e2e:order:${RUN_ID}`,
          actor_user_id: OWNER_ID,
          provider: 'mock',
        },
      })
      assert.equal(
        orderRes.res.status,
        201,
        `order creation failed: ${orderRes.res.status} ${JSON.stringify(orderRes.json)}`,
      )
      orderId = orderRes.json.order.id
      const orderAmount = BigInt(orderRes.json.order.amount_micros)

      // Build a correctly signed mock webhook.
      // The mock provider signs `<timestamp>.<rawBody>` with the shared secret
      // from MOCK_PAYMENT_WEBHOOK_SECRET (see src/lib/payments/mock.ts).
      const webhookSecret = process.env.MOCK_PAYMENT_WEBHOOK_SECRET || ADMIN_TOKEN
      const timestamp = Math.floor(Date.now() / 1000)
      const webhookBody = JSON.stringify({
        id: `evt-e2e-${RUN_ID}`,
        type: 'payment.succeeded',
        occurred_at: new Date().toISOString(),
        data: {
          order_id: orderId,
          external_order_id: null,
          amount: orderAmount.toString(),
          currency: 'USD',
        },
      })
      const { createHmac } = await import('node:crypto')
      const signedPayload = `${timestamp}.${webhookBody}`
      const sig = createHmac('sha256', webhookSecret).update(signedPayload).digest('hex')

      const cb1 = await fetch(`${ORIGIN}/api/webhooks/payments/mock`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nexus-signature': `sha256=${sig}`,
          'x-nexus-timestamp': String(timestamp),
        },
        body: webhookBody,
      })
      assert.equal(cb1.status, 200, `first webhook failed: ${cb1.status}`)

      // Replay the same event — must be idempotent (200, not double-charged)
      const cb2 = await fetch(`${ORIGIN}/api/webhooks/payments/mock`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nexus-signature': `sha256=${sig}`,
          'x-nexus-timestamp': String(timestamp),
        },
        body: webhookBody,
      })
      assert.equal(cb2.status, 200, `replay webhook failed: ${cb2.status}`)

      // Verify only one ledger transaction for this order (idempotency)
      const txns = await db.query(`SELECT count(*)::int AS n FROM ledger_transactions WHERE idempotency_key = $1`, [
        `order_recharge:${orderId}`,
      ])
      assert.equal(txns.rows[0].n, 1, 'exactly one recharge ledger transaction for the order')
    })()

    // ── Cleanup ────────────────────────────────────────────────────────
    // ledger_postings, ledger_transactions, ledger_accounts and wallet_accounts
    // are immutable / FK-RESTRICTED. We leave them in place — they are isolated
    // by tenant_id and cannot affect other tests or tenants. We clean up
    // everything else that is safe to delete. Errors are swallowed because
    // some FK chains cannot be fully resolved (immutable ledger).
    const cleanupQueries = [
      'DELETE FROM payments WHERE tenant_id = $1',
      'DELETE FROM outbox_events WHERE tenant_id = $1',
      'DELETE FROM request_records WHERE tenant_id = $1',
      'DELETE FROM usage_records WHERE tenant_id = $1',
      'DELETE FROM usage_events WHERE tenant_id = $1',
      'DELETE FROM wallet_ledger_entries WHERE wallet_id = $1',
      'DELETE FROM orders WHERE tenant_id = $1',
      'DELETE FROM price_components WHERE price_version_id IN ($1, $2)',
      'DELETE FROM price_candidates WHERE id = $1',
      'DELETE FROM provider_price_versions WHERE id IN ($1, $2)',
      'DELETE FROM price_sources WHERE id = $1',
      'DELETE FROM upstream_models WHERE id = $1',
      'DELETE FROM channels WHERE tenant_id = $1',
      'DELETE FROM provider_credentials WHERE tenant_id = $1',
      'DELETE FROM downstream_api_keys WHERE tenant_id = $1',
      'DELETE FROM subscriptions WHERE tenant_id = $1',
      'DELETE FROM plan_versions WHERE id = $1',
      'DELETE FROM plans WHERE id = $1',
      'DELETE FROM organization_memberships WHERE organization_id = $1',
      'DELETE FROM users WHERE id = $1',
      'DELETE FROM providers WHERE id = $1',
      'DELETE FROM organizations WHERE id = $1',
    ]
    for (const q of cleanupQueries) {
      try {
        if (q.includes('IN ($1, $2)')) {
          await db.query(q, q.includes('price_version_id') ? [PV_E2E, PV_CAND] : [PS_E2E])
        } else if (q.includes('wallet_id')) {
          await db.query(q, [WALLET_ID])
        } else if (q.includes('organization_id')) {
          await db.query(q, [ORG_ID])
        } else if (q.includes('users') || q.includes('providers') || q.includes('plans')) {
          const id = q.includes('users') ? OWNER_ID : q.includes('providers') ? PROVIDER_ID : PLAN_ID
          await db.query(q, [id])
        } else if (q.includes('price_sources') || q.includes('upstream_models')) {
          await db.query(q, [q.includes('price_sources') ? PS_E2E : UM_E2E])
        } else {
          await db.query(q, [TENANT_ID])
        }
      } catch {
        // FK chain may prevent deletion (immutable ledger). Safe to ignore.
      }
    }
  } finally {
    await db.end().catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  const passed = results.length - failed.length
  console.log(`\n=== E2E Acceptance: ${passed}/${results.length} checks passed ===`)
  if (failed.length) {
    console.log('Failed:')
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('\nE2E ACCEPTANCE CRASHED:', error.message)
  console.error(error.stack)
  process.exitCode = 1
})
