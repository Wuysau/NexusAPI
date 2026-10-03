// Playwright end-to-end coverage for the Work Item H control plane.
//
// Runs against an already-running dev server (default http://localhost:3000,
// override with TEST_ORIGIN) and a migrated Postgres (DATABASE_URL). The
// dev-only demo data is created by scripts/seed-dev.mjs, which this spec runs
// itself so the suite is self-contained. It refuses NODE_ENV=production.
//
// Covered flows:
//   1. new org onboarding (empty states → first key)
//   2. create + revoke a downstream key
//   3. add a BYOK channel using independently provisioned opaque references
//   4. publish a price (approve a candidate, semantic diff + fresh auth)
//   5. key revocation blocks API access (the control-plane half of
//      budget/key blocking — the budget enforcement itself lives in the
//      billing pipeline/gateway, outside Work Item H)
//   6. billing view (balance from the ledger)
//   7. unauthorized access (anonymous → login, viewer → 403 / hidden actions)

import 'dotenv/config'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import pg from 'pg'
import { chromium } from 'playwright'
import { projectAnalyticsE2E } from './project-analytics.mjs'
import { subscriptionObserverE2E } from './subscription-observer.mjs'
import { workspaceManagementE2E } from './workspace-management.mjs'
import { playgroundE2E } from './playground.mjs'
import { requestTraceE2E } from './request-trace.mjs'

const ORIGIN = process.env.TEST_ORIGIN || 'http://localhost:3000'
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/app_db'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const OWNER = { email: 'dev@nexus.local', password: process.env.DEV_ADMIN_PASSWORD }
const VIEWER = { email: 'viewer@nexus.local', password: process.env.DEV_VIEWER_PASSWORD }
if (!OWNER.password || !VIEWER.password)
  throw new Error('DEV_ADMIN_PASSWORD and DEV_VIEWER_PASSWORD are required for E2E')

const results = []
function check(name, fn) {
  return async () => {
    try {
      await fn()
      results.push({ name, ok: true })
      console.log(`PASS  ${name}`)
    } catch (error) {
      results.push({ name, ok: false, error: error.message })
      console.log(`FAIL  ${name}  — ${error.message}`)
    }
  }
}

async function api(path, { method = 'GET', body, cookies, csrf } = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookies) headers.cookie = cookies
  if (csrf) headers['x-csrf-token'] = csrf
  const res = await fetch(ORIGIN + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { res, json }
}

async function loginCookies(credentials) {
  const res = await fetch(ORIGIN + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  })
  const raw = res.headers.getSetCookie()
  const cookies = raw.map((c) => c.split(';')[0]).join('; ')
  const csrf = cookies
    .split('; ')
    .find((c) => c.startsWith('nexus_csrf='))
    ?.split('=')[1]
  return { status: res.status, cookies, csrf, body: await res.json().catch(() => null) }
}

async function loggedInContext(browser, credentials) {
  const auth = await loginCookies(credentials)
  assert.equal(auth.status, 200, `login failed for ${credentials.email}`)
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  context.setDefaultTimeout(10000)
  await context.addCookies([
    { name: 'nexus_session', value: auth.cookies.match(/nexus_session=([^;]+)/)[1], url: ORIGIN, httpOnly: true },
    { name: 'nexus_csrf', value: auth.csrf, url: ORIGIN },
  ])
  return { context, auth }
}

export async function runControlPlaneE2E() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to run the dev e2e suite with NODE_ENV=production')
  }

  // 0. Dev demo data (idempotent, dev-only) + a fresh pending price candidate.
  execFileSync(process.execPath, ['scripts/seed-dev.mjs'], { cwd: ROOT, stdio: 'inherit', env: process.env })

  const db = new pg.Client({ connectionString: DATABASE_URL })
  await db.connect()
  await db.query("UPDATE price_candidates SET status = 'pending_approval' WHERE id = 'pc-gpt-4o-2'")
  // Controlled manual evidence exists only in this disposable E2E database.
  // Keep the seeded .invalid source intact so its refusal is covered as well.
  const manualPriceHash = createHash('sha256')
    .update('E2E controlled manual fixture: input 2.75; output 11; USD per million tokens')
    .digest('hex')
  await db.query(
    `INSERT INTO price_sources(id,provider_id,upstream_model_id,source_type,source_url,content_sha256,parser_version,region,currency)
    VALUES('ps-e2e-manual','prov-openai','e2e-manual-model','manual',NULL,$1,'e2e-controlled-fixture','global','USD')
    ON CONFLICT(id) DO NOTHING`,
    [manualPriceHash],
  )
  await db.query(`INSERT INTO provider_price_versions(id,provider_id,upstream_model_id,currency,region,service_tier,input_price,output_price,unit,source_type,status,fetched_at)
    VALUES('pv-e2e-manual','prov-openai','e2e-manual-model','USD','global','default','2.75','11','per_million_tokens','manual','pending',now())
    ON CONFLICT(id) DO UPDATE SET status='pending'`)
  await db.query(`INSERT INTO price_candidates(id,provider_id,upstream_model_id,price_source_id,currency,region,status,high_risk_flag,risk_reasons)
    VALUES('pc-e2e-manual','prov-openai','e2e-manual-model','ps-e2e-manual','USD','global','pending_approval',false,'[]'::jsonb)
    ON CONFLICT(id) DO UPDATE SET status='pending_approval'`)
  await db.query(`INSERT INTO price_components(id,price_version_id,price_candidate_id,kind,unit,amount)
    VALUES('pcomp-e2e-manual-in','pv-e2e-manual','pc-e2e-manual','input','per_million_tokens','2.75'),
      ('pcomp-e2e-manual-out','pv-e2e-manual','pc-e2e-manual','output','per_million_tokens','11')
    ON CONFLICT(id) DO NOTHING`)
  await db.query(
    `INSERT INTO audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
     VALUES ('ae-e2e-marker','tenant-dev','user-dev-owner','e2e.marker','test','e2e','{"demo":true}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  )

  // Sweep leftovers from an earlier interrupted run so the suite is repeatable.
  await db.query("DELETE FROM downstream_api_keys WHERE organization_id LIKE 'org-e2e-%' OR name LIKE 'E2E %'")
  await db.query("DELETE FROM organization_memberships WHERE organization_id LIKE 'org-e2e-%'")
  await db.query("DELETE FROM users WHERE id LIKE 'user-e2e-%'")
  await db.query("DELETE FROM organizations WHERE id LIKE 'org-e2e-%'")

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const pageErrors = []

  try {
    // ── Flow 7a: anonymous access is redirected to the login screen ────
    await check('anonymous visitor sees login, not the console', async () => {
      const context = await browser.newContext()
      const page = await context.newPage()
      page.on('pageerror', (e) => pageErrors.push(e.message))
      await page.goto(ORIGIN, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: '登录控制台' }).waitFor({ timeout: 15000 })
      assert.equal(await page.getByRole('heading', { name: '数据概览' }).count(), 0)
      await context.close()
    })()

    const owner = await loggedInContext(browser, OWNER)
    const ownerPage = await owner.context.newPage()
    ownerPage.on('pageerror', (e) => pageErrors.push(e.message))

    // ── Flow 1: new org onboarding — empty states, then first key ──────
    const suffix = createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8)
    const newOrgSlug = `e2e-org-${suffix}`
    const newEmail = `e2e-${suffix}@nexus.local`
    const newTenant = `tenant-e2e-${suffix}`
    await db.query(`INSERT INTO organizations (id, tenant_id, name, slug, kind) VALUES ($1,$2,$3,$4,'customer')`, [
      `org-${suffix}`,
      newTenant,
      `E2E Org ${suffix}`,
      newOrgSlug,
    ])
    const devHash = (await db.query('SELECT password_hash FROM users WHERE id = $1', ['user-dev-owner'])).rows[0]
      .password_hash
    await db.query(`INSERT INTO users (id, email, password_hash, name) VALUES ($1,$2,$3,$4)`, [
      `user-e2e-${suffix}`,
      newEmail,
      devHash,
      `E2E ${suffix}`,
    ])
    await db.query(
      `INSERT INTO organization_memberships (id, organization_id, tenant_id, user_id, role) VALUES ($1,$2,$3,$4,'owner')`,
      [`mem-e2e-${suffix}`, `org-${suffix}`, newTenant, `user-e2e-${suffix}`],
    )

    await check('new org sees empty states and creates its first key', async () => {
      const fresh = await loggedInContext(browser, { email: newEmail, password: OWNER.password })
      const page = await fresh.context.newPage()
      page.on('pageerror', (e) => pageErrors.push(e.message))
      await page.goto(ORIGIN + '/keys', { waitUntil: 'networkidle' })
      await page.getByText('尚未创建密钥', { exact: true }).waitFor({ timeout: 15000 })
      await page.getByRole('button', { name: '创建 API 密钥' }).first().click()
      await page.locator('input[name="name"]').fill('First Key')
      await page.getByRole('button', { name: '创建密钥' }).click()
      await page.getByTestId('created-key').waitFor({ timeout: 15000 })
      const token = await page.getByTestId('created-key').innerText()
      assert.match(token, /^sk-nx-[0-9a-f]{48}$/, 'new key has the expected shape')
      await page.getByRole('button', { name: '我已保存' }).click()
      await page.getByText('First Key', { exact: true }).waitFor()
      await fresh.context.close()
    })()

    // ── Flow 2: create + revoke a downstream key (owner) ───────────────
    await check('create then revoke a downstream key', async () => {
      await ownerPage.goto(ORIGIN + '/keys', { waitUntil: 'networkidle' })
      await ownerPage.getByRole('button', { name: '创建 API 密钥' }).first().click()
      const keyName = `E2E Revocable Key ${suffix}`
      await ownerPage.locator('input[name="name"]').fill(keyName)
      await ownerPage.getByRole('button', { name: '创建密钥' }).click()
      await ownerPage.getByTestId('created-key').waitFor({ timeout: 15000 })
      const token = await ownerPage.getByTestId('created-key').innerText()
      await ownerPage.getByRole('button', { name: '我已保存' }).click()
      const row = ownerPage.locator('tr', { hasText: keyName })
      await row.waitFor()
      // Fresh session (just logged in) → revoke succeeds without re-auth.
      await row.getByRole('button', { name: '撤销密钥' }).click()
      await ownerPage.getByText('密钥已撤销').waitFor({ timeout: 15000 })
      await ownerPage.getByText('已撤销', { exact: true }).first().waitFor()
      const revoked = await db.query('SELECT enabled, revoked_at FROM downstream_api_keys WHERE name = $1', [keyName])
      assert.equal(revoked.rowCount, 1, 'key row persisted')
      assert.equal(revoked.rows[0].enabled, false)
      assert.ok(revoked.rows[0].revoked_at, 'revoked_at is set')
      assert.notEqual(token, '')
    })()

    // ── Flow 3: independently provisioned opaque BYOK references ───────
    const channelName = `E2E BYOK ${suffix}`
    await check('add a BYOK channel with opaque enrollment and reject secret disclosure', async () => {
      const credentialId = `e2e-enrolled-${suffix}`
      const otherCredentialId = `e2e-other-${suffix}`
      const ciphertextMarker = `synthetic-encrypted-other-tenant-${suffix}`
      // Fixture provisioning is outside HTTP/CP enrollment. The actual encrypted
      // registry + Vault operations are proved by the separate real KMS gate.
      await db.query(
        "INSERT INTO provider_credentials(id,provider_id,organization_id,tenant_id,name,encrypted_secret) VALUES($1,'prov-openai','org-dev','tenant-dev',$2,'external-registry:v1'),($3,'prov-openai',$4,$5,'Other tenant encrypted fixture',$6)",
        [credentialId, `${channelName} credential`, otherCredentialId, `org-${suffix}`, newTenant, ciphertextMarker],
      )
      try {
        await ownerPage.goto(ORIGIN + '/channels', { waitUntil: 'networkidle' })
        await ownerPage.getByRole('button', { name: '添加渠道' }).click()
        assert.equal(await ownerPage.locator('input[name="secret"]').count(), 0, 'browser has no plaintext intake')
        await ownerPage.locator('input[name="name"]').fill(channelName)
        await ownerPage.getByRole('combobox', { name: '上游供应商' }).selectOption('prov-openai')
        await ownerPage.locator('input[name="credentialId"]').fill(credentialId)
        await ownerPage.locator('input[name="credentialVersion"]').fill('2')
        const createdResponse = ownerPage.waitForResponse(
          (response) => response.url().endsWith('/api/channels') && response.request().method() === 'POST',
        )
        await ownerPage.getByRole('button', { name: '保存渠道' }).click()
        const created = await createdResponse
        assert.equal(created.status(), 201)
        const createdJson = await created.json()
        assert.equal(createdJson.channel.credential.id, credentialId)
        const serialized = JSON.stringify(createdJson)
        assert.doesNotMatch(serialized, /"(?:secret|ciphertext|encrypted_secret|encrypted_data_key)"\s*:/)
        assert.ok(!serialized.includes(ciphertextMarker))
        await ownerPage.getByText('渠道已创建').waitFor({ timeout: 15000 })
        await ownerPage.locator('tr', { hasText: channelName }).getByText('已记录凭据引用', { exact: true }).waitFor()
        const stored = await db.query(
          'SELECT pc.encrypted_secret,pc.encrypted_data_key,c.metadata FROM channels c JOIN provider_credentials pc ON pc.id=c.provider_credential_id WHERE c.name=$1',
          [channelName],
        )
        assert.equal(stored.rowCount, 1)
        assert.equal(stored.rows[0].encrypted_secret, 'external-registry:v1', 'opaque reference retained')
        assert.equal(stored.rows[0].encrypted_data_key, null, 'CP has no wrapped DEK')
        assert.equal(stored.rows[0].metadata.credential_version, 2)
        const crossed = await api('/api/channels', {
          method: 'POST',
          cookies: owner.auth.cookies,
          csrf: owner.auth.csrf,
          body: {
            name: 'Cross-tenant refusal',
            provider: 'openai',
            credentialId: otherCredentialId,
            credentialVersion: 1,
          },
        })
        assert.equal(crossed.res.status, 409, 'foreign tenant credential cannot be attached')
        const plaintext = await api('/api/channels', {
          method: 'POST',
          cookies: owner.auth.cookies,
          csrf: owner.auth.csrf,
          body: { name: 'Plaintext refusal', provider: 'openai', secret: 'fixture-secret' },
        })
        assert.equal(plaintext.res.status, 403)
        assert.equal(plaintext.json.error.code, 'local_key_input_unavailable')
        assert.ok(!JSON.stringify(plaintext.json).includes('fixture-secret'))
        const retired = await api('/api/internal/gateway/credential', {
          method: 'POST',
          body: { credential_id: credentialId },
        })
        assert.equal(retired.res.status, 410, 'old plaintext endpoint remains retired')
        const listed = await api('/api/channels', { cookies: owner.auth.cookies })
        assert.doesNotMatch(
          JSON.stringify(listed.json),
          /"(?:secret|ciphertext|encrypted_secret|encrypted_data_key)"\s*:/,
        )
        assert.ok(!JSON.stringify(listed.json).includes(ciphertextMarker))
      } finally {
        await db.query('DELETE FROM provider_credentials WHERE id=$1', [otherCredentialId])
      }
    })()

    // ── Flow 4: publish a price (approve candidate) ────────────────────
    await check('publish a price from the approval queue', async () => {
      await ownerPage.goto(ORIGIN + '/pricing', { waitUntil: 'networkidle' })
      const demo = ownerPage
        .getByRole('article')
        .filter({ has: ownerPage.getByRole('heading', { name: 'gpt-4o', exact: true }) })
      await demo.getByText('演示价格来源，不能批准或生效。请提交真实来源的价格候选。').waitFor()
      assert.equal(await demo.getByRole('button', { name: '批准', exact: true }).isDisabled(), true)
      const card = ownerPage
        .getByRole('article')
        .filter({ has: ownerPage.getByRole('heading', { name: 'e2e-manual-model', exact: true }) })
      await card.getByRole('heading', { name: '价格差异', exact: true }).waitFor({ timeout: 15000 })
      await card.getByRole('button', { name: '批准' }).click()
      await ownerPage.getByTestId('confirm-decision').click()
      await ownerPage.getByText('价格已批准').waitFor({ timeout: 15000 })
      const candidate = await db.query("SELECT status FROM price_candidates WHERE id = 'pc-e2e-manual'")
      assert.ok(
        ['active', 'scheduled'].includes(candidate.rows[0].status),
        `candidate status ${candidate.rows[0].status}`,
      )
    })()

    // ── Flow 5: disabling a key blocks data-plane access ───────────────
    await check('key disable blocks API access', async () => {
      const created = await api('/api/keys', {
        method: 'POST',
        cookies: owner.auth.cookies,
        csrf: owner.auth.csrf,
        body: { name: `E2E Disable Key ${suffix}` },
      })
      assert.equal(created.res.status, 201, JSON.stringify(created.json))
      const token = created.json.token
      const enabledRow = await db.query('SELECT enabled FROM downstream_api_keys WHERE id = $1', [created.json.key.id])
      assert.equal(enabledRow.rows[0].enabled, true)
      const off = await api(`/api/keys/${created.json.key.id}`, {
        method: 'PATCH',
        cookies: owner.auth.cookies,
        csrf: owner.auth.csrf,
        body: { enabled: false },
      })
      assert.equal(off.res.status, 200, JSON.stringify(off.json))
      const disabledRow = await db.query('SELECT enabled FROM downstream_api_keys WHERE id = $1', [created.json.key.id])
      assert.equal(disabledRow.rows[0].enabled, false, 'disabled key is no longer effective')
      const listed = await api('/api/keys', { cookies: owner.auth.cookies })
      const entry = listed.json.keys.find((k) => k.id === created.json.key.id)
      assert.equal(entry.status, 'disabled')
      assert.notEqual(token, '')
    })()

    // ── Flow 6: billing view reads the ledger ──────────────────────────
    await check('billing view shows the ledger balance', async () => {
      await ownerPage.goto(ORIGIN + '/billing', { waitUntil: 'networkidle' })
      await ownerPage.getByText('账本余额 · USD', { exact: true }).waitFor({ timeout: 15000 })
      const balance = await api('/api/billing', { cookies: owner.auth.cookies })
      assert.equal(balance.res.status, 200)
      assert.match(balance.json.balance, /^\d+\.\d{6}$/, 'balance is a decimal-micros string')
      assert.equal(balance.json.analytics.groupBy, 'project')
      assert.match(balance.json.analytics.totals.requests, /^\d+$/)
      const invalidAnalytics = await api('/api/billing?offset=1.5', { cookies: owner.auth.cookies })
      assert.equal(invalidAnalytics.res.status, 400)
      await ownerPage
        .getByText('$' + Number(balance.json.balance).toFixed(2))
        .first()
        .waitFor()
    })()

    await check('Project Analytics real response, filters, unknown, currencies and 403', async () => {
      await projectAnalyticsE2E(ownerPage, db, ORIGIN)
    })()

    await check('Subscription Observer provenance, counts and source filters', async () => {
      await subscriptionObserverE2E(ownerPage, db, ORIGIN)
    })()

    await check('Workspace project and connection lifecycle, persistence, setup and responsive layout', async () => {
      await workspaceManagementE2E(ownerPage, db, ORIGIN)
    })()

    await check('Project Playground transient multi-turn, cancel, ownership, unknown usage and no replay', async () => {
      await playgroundE2E(ownerPage, ORIGIN)
    })()

    await check('Recorded request trace detail, visibility and selection ownership', async () => {
      await requestTraceE2E(ownerPage, db, ORIGIN)
    })()

    // ── Flow 7b: viewer is read-only (server-enforced, UI hidden) ──────
    await check('viewer cannot approve prices (403 + hidden action)', async () => {
      const viewer = await loggedInContext(browser, VIEWER)
      const projectReport = await api('/api/billing', { cookies: viewer.auth.cookies })
      assert.equal(projectReport.res.status, 200)
      assert.equal(projectReport.json.wallet, null, 'Project-only viewer cannot see organization wallet')
      assert.deepEqual(projectReport.json.orders, [])
      const foreignProject = await api('/api/logs?projectId=nonexistent-project', { cookies: viewer.auth.cookies })
      assert.equal(foreignProject.res.status, 404)
      const forbidden = await api('/api/pricing', {
        method: 'POST',
        cookies: viewer.auth.cookies,
        csrf: viewer.auth.csrf,
        body: { candidateId: 'pc-gpt-4o-2', action: 'approve' },
      })
      assert.equal(forbidden.res.status, 403, JSON.stringify(forbidden.json))
      const audit = await api('/api/audit', { cookies: viewer.auth.cookies })
      assert.equal(audit.res.status, 403)
      const page = await viewer.context.newPage()
      await page.goto(ORIGIN + '/pricing', { waitUntil: 'networkidle' })
      await page.getByText('价格审批').first().waitFor({ timeout: 15000 })
      assert.equal(await page.getByRole('button', { name: '批准' }).count(), 0, 'approve action hidden for viewer')
      await page.goto(ORIGIN + '/projects', { waitUntil: 'networkidle' })
      assert.equal(await page.getByRole('button', { name: '创建项目', exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: '编辑', exact: true }).count(), 0)
      await page.goto(ORIGIN + '/connections', { waitUntil: 'networkidle' })
      assert.equal(await page.getByRole('button', { name: '添加连接', exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: '撤销连接', exact: true }).count(), 0)
      await viewer.context.close()
    })()

    await check('mobile layout has no horizontal overflow', async () => {
      const page = await owner.context.newPage()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(ORIGIN, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: '数据概览' }).first().waitFor({ timeout: 15000 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      await page.getByRole('button', { name: '打开菜单' }).click()
      await page.getByRole('link', { name: '渠道管理' }).click()
      await page.getByRole('heading', { name: '渠道管理' }).first().waitFor({ timeout: 15000 })
      await page.close()
    })()

    await check('no browser runtime errors', async () => {
      assert.deepEqual(pageErrors, [])
    })()

    await ownerPage.screenshot({ path: '.test-artifacts/control-plane-overview.png', fullPage: true }).catch(() => {})
    await owner.context.close()

    // Clean up the throwaway organization created for flow 1.
    await db.query('DELETE FROM downstream_api_keys WHERE organization_id = $1', [`org-${suffix}`])
    await db.query('DELETE FROM organization_memberships WHERE organization_id = $1', [`org-${suffix}`])
    await db.query('DELETE FROM users WHERE id = $1', [`user-e2e-${suffix}`])
    await db.query('DELETE FROM organizations WHERE id = $1', [`org-${suffix}`])

    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} e2e flows passed`)
    if (failed.length) {
      throw new Error(`e2e failures: ${failed.map((f) => f.name).join(', ')}`)
    }
  } finally {
    await browser.close().catch(() => {})
    await db.end().catch(() => {})
  }
}

export { ORIGIN }
