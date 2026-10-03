// Actual Next app + Chromium + isolated PostgreSQL. No Gateway or model process.
// Invoke with an explicit guarded DATABASE_URL. --old-ui / --old-revoke-ui
// select one denial case; RED requires actual old UI with the repaired backend.
// --revocation-only runs five revocation cases; the default runs all ten cases.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { chromium } from 'playwright'
import { runMigrations } from '../../scripts/db-migrate.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const artifacts = join(root, '.test-artifacts/connection-revoke-browser-audit')
const target = new URL(process.env.DATABASE_URL ?? 'http://invalid')
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.port !== '55439' ||
  target.pathname !== '/connector_test_reauth_browser_round54' ||
  (process.env.DATABASE_URL ?? '').includes('?') ||
  (process.env.DATABASE_URL ?? '').includes('#') ||
  process.env.NODE_ENV === 'production'
)
  throw new Error('Exact independent browser fixture required')
if (existsSync(join(root, '.next/dev/lock'))) throw new Error('An existing root Next development lock is present')
const oldUI = process.argv.includes('--old-ui')
const oldRevokeUI = process.argv.includes('--old-revoke-ui')
const revocationOnly = oldRevokeUI || process.argv.includes('--revocation-only')
assert.equal(oldUI && revocationOnly, false, 'Select one browser baseline')
const password = randomBytes(24).toString('base64url')
const email = 'reauth-browser@example.invalid'
const submitted = ['reauth-model-a', 'reauth-model-b']
const user = 'reauth-browser-admin'
const db = new pg.Pool({ connectionString: target.href, max: 2 })
const cases = []
const observations = []
const browserErrors = []
const rootTypes = await readFile(join(root, 'next-env.d.ts'))
let nextProcess,
  browser,
  origin,
  runtime,
  stage = 'setup',
  nextOutput = ''

function deferred() {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function within(promise, label, timeout = 10000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function check(name, fn) {
  stage = 'fixture'
  try {
    await fn()
    cases.push({ name, ok: true })
    console.log('PASS browser: ' + name)
  } catch {
    cases.push({ name, ok: false, stage })
    console.log('FAIL browser: ' + name + ' [' + stage + ']')
  }
}
async function post(context, path, data) {
  const csrf = (await context.cookies()).find((cookie) => cookie.name === 'nexus_csrf')?.value
  return context.request.post(origin + path, { headers: { 'x-csrf-token': csrf ?? '' }, data })
}
async function fixture(stale = true, withReplacement = false, intent = 'pair') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  context.setDefaultTimeout(10000)
  context.setDefaultNavigationTimeout(90000)
  stage = 'login fixture'
  const login = await context.request.post(origin + '/api/auth/login', { data: { email, password } })
  observations.push({ loginStatus: login.status() })
  assert.equal(login.status(), 200)
  const cookie = (await context.cookies()).find((value) => value.name === 'nexus_session')?.value
  assert.ok(cookie)
  const sessionId = (
    await db.query('SELECT id FROM sessions WHERE token_hash=$1', [createHash('sha256').update(cookie).digest('hex')])
  ).rows[0]?.id
  assert.ok(sessionId)
  stage = 'create connection fixture'
  const created = await post(context, '/api/connections', {
    provider: 'ollama',
    mode: 'local_sidecar',
    projectId: 'reauth-browser-project',
  })
  assert.equal(created.status(), 201)
  const id = (await created.json()).connection.id
  let replacement
  if (withReplacement) {
    const second = await post(context, '/api/connections', {
      provider: 'ollama',
      mode: 'local_sidecar',
      projectId: 'reauth-browser-project',
    })
    assert.equal(second.status(), 201)
    replacement = (await second.json()).connection.id
  }
  if (intent === 'revoke') {
    stage = 'active native connector fixture'
    const configured = await post(context, `/api/connections/${id}/connector`, { models: submitted })
    assert.equal(configured.status(), 200)
    const pairing = await configured.json()
    const paired = await context.request.post(origin + '/api/connector/pair', {
      headers: { authorization: `Bearer ${pairing.pairingToken}` },
    })
    assert.equal(paired.status(), 200)
    const identity = await paired.json()
    const leased = await context.request.post(origin + '/api/connector/lease', {
      headers: { authorization: `Bearer ${identity.credential}` },
      data: { readyModels: submitted },
    })
    assert.equal(leased.status(), 200)
    assert.ok((await leased.json()).leaseToken)
  }
  if (stale) await db.query("UPDATE sessions SET created_at=now()-interval '16 minutes' WHERE id=$1", [sessionId])
  const session = await (await context.request.get(origin + '/api/auth/session')).json()
  stage = 'verify stale session fixture'
  assert.equal(session.authenticated, true)
  assert.equal(session.freshAuth, !stale)
  const page = await context.newPage()
  page.on('pageerror', (error) => {
    const redact = (value) =>
      String(value)
        .replaceAll(password, '<password>')
        .replaceAll(cookie, '<session>')
        .replace(/\b(nxpair_|nxidentity_|nxlease_)[A-Za-z0-9_-]+/g, '<ephemeral-token>')
        .replace(/(?:https?|postgresql?):\/\/[^\s'"<>]+/g, '<url>')
    browserErrors.push({
      name: error.name,
      message: redact(error.message),
      stack: redact(
        error.stack
          ?.split('\n')
          .filter((line) => line.trim().startsWith('at '))
          .slice(0, 3)
          .join('\n'),
      ),
    })
  })
  stage = 'open connection page'
  await page.goto(origin + '/connections')
  stage = 'find connection row'
  await page.getByLabel('搜索供应商、项目或连接 ID', { exact: true }).fill(id)
  let panel
  if (intent === 'revoke') {
    await page.getByRole('button', { name: '撤销连接', exact: true }).click()
    await revokeDialog(page).waitFor()
  } else {
    await page.getByRole('button', { name: /^(配置与详情|查看记录)$/ }).click()
    stage = 'open local connector panel'
    panel = page.getByRole('region', { name: '本地连接器配置', exact: true })
    await panel.getByRole('heading', { name: 'Ollama 本地连接器', exact: true }).waitFor()
    stage = 'edit configured models'
    await panel.getByLabel('连接器模型 ID', { exact: true }).fill(submitted.join('\n'))
  }
  const configurePath = `/api/connections/${id}/connector`
  const revokePath = `/api/connections/${id}`
  const posts = []
  const allConfigurePosts = []
  const authPosts = []
  const deletes = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'DELETE' && /^\/api\/connections\/[^/]+$/.test(path)) deletes.push(path)
    if (request.method() !== 'POST') return
    if (path === '/api/auth/reauth') authPosts.push(path)
    if (/^\/api\/connections\/[^/]+\/connector$/.test(path)) {
      allConfigurePosts.push(path)
      if (path === configurePath) posts.push(request.postDataJSON().models)
    }
  })
  return {
    context,
    page,
    panel,
    id,
    replacement,
    cookie,
    sessionId,
    configurePath,
    posts,
    allConfigurePosts,
    authPosts,
    revokePath,
    deletes,
  }
}
const issueButton = (panel) =>
  panel.getByRole('button', { name: '保存模型并生成一次性配对令牌 / 轮换身份', exact: true })
const reauthDialog = (page) => page.getByRole('dialog', { name: '重新验证身份', exact: true })
const revokeDialog = (page) => page.getByRole('dialog', { name: '撤销连接', exact: true })
const confirmRevoke = (page) => revokeDialog(page).getByRole('button', { name: '确认撤销', exact: true })
const visibleTokens = (panel) => panel.locator('code').filter({ hasText: /^nxpair_/ })
async function facts(id) {
  const result = {}
  for (const table of [
    'owned_connections',
    'channels',
    'provider_credentials',
    'connector_pairings',
    'connector_identities',
    'connector_leases',
  ]) {
    const column = table === 'connector_pairings' ? 'connection_id' : 'id'
    result[table] = (await db.query(`SELECT * FROM ${table} ORDER BY ${column}`)).rows
  }
  result.audits = (
    await db.query(
      "SELECT * FROM audit_events WHERE action IN ('connector.pairing_issued','connection.revoked') AND target_id=$1 ORDER BY id",
      [id],
    )
  ).rows
  return result
}
async function startDenied(f) {
  const before = await facts(f.id)
  const response = f.page.waitForResponse(
    (response) => new URL(response.url()).pathname === f.configurePath && response.request().method() === 'POST',
  )
  void response.catch(() => {})
  await issueButton(f.panel).click()
  stage = 'real stale denial'
  assert.equal((await response).status(), 401)
  assert.equal(isDeepStrictEqual(await facts(f.id), before), true)
  assert.equal(await visibleTokens(f.panel).count(), 0)
  assert.equal(f.posts.length, 1)
  observations.push({ staleStatus: 401, configurePosts: 1, connectorFactsUnchanged: true, tokenVisible: false })
  stage = 'reauthentication dialog'
  await reauthDialog(f.page).waitFor({ state: 'visible', timeout: oldUI ? 3000 : 10000 })
  return before
}
async function staleCancel() {
  const f = await fixture()
  try {
    const before = await startDenied(f)
    await reauthDialog(f.page).getByRole('button', { name: '取消', exact: true }).click()
    await reauthDialog(f.page).waitFor({ state: 'hidden' })
    stage = 'cancel preserves pending operation'
    assert.equal(f.posts.length, 1)
    assert.equal(f.authPosts.length, 0)
    assert.equal(isDeepStrictEqual(await facts(f.id), before), true)
    assert.equal(await visibleTokens(f.panel).count(), 0)
    assert.equal(await issueButton(f.panel).isEnabled(), true)
  } finally {
    await f.context.close()
  }
}
async function realReauth() {
  const f = await fixture()
  try {
    await startDenied(f)
    // Deliberate input-state mutation while the modal is open tests that the
    // pending action keeps its submitted models, rather than reading new state.
    await f.panel.getByLabel('连接器模型 ID', { exact: true }).evaluate((node) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(node, 'changed-after-submit')
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(await f.panel.getByLabel('连接器模型 ID', { exact: true }).inputValue(), 'changed-after-submit')
    const retried = f.page.waitForResponse(
      (response) => new URL(response.url()).pathname === f.configurePath && response.request().method() === 'POST',
    )
    void retried.catch(() => {})
    await reauthDialog(f.page).getByLabel('登录密码', { exact: true }).fill(password)
    await reauthDialog(f.page).getByRole('button', { name: '验证', exact: true }).click()
    stage = 'real session rotation and single retry'
    assert.equal((await retried).status(), 200)
    await visibleTokens(f.panel).waitFor()
    assert.deepEqual(f.posts, [submitted, submitted])
    assert.equal(f.authPosts.length, 1)
    const current = (await f.context.cookies()).find((cookie) => cookie.name === 'nexus_session')?.value
    assert.ok(current && current !== f.cookie)
    assert.ok((await db.query('SELECT revoked_at FROM sessions WHERE id=$1', [f.sessionId])).rows[0].revoked_at)
    const session = await (await f.context.request.get(origin + '/api/auth/session')).json()
    assert.equal(session.freshAuth, true)
    assert.equal((await facts(f.id)).audits.length, 1)
    const capabilities = (await db.query('SELECT capabilities FROM owned_connections WHERE id=$1', [f.id])).rows[0]
      .capabilities
    assert.deepEqual(capabilities.models, submitted)
    await f.panel.getByRole('button', { name: '已保存，隐藏令牌', exact: true }).click()
    assert.equal(await visibleTokens(f.panel).count(), 0)
  } finally {
    await f.context.close()
  }
}
async function freshNormal() {
  const f = await fixture(false)
  try {
    const response = f.page.waitForResponse(
      (response) => new URL(response.url()).pathname === f.configurePath && response.request().method() === 'POST',
    )
    void response.catch(() => {})
    await issueButton(f.panel).click()
    stage = 'fresh single issuance'
    assert.equal((await response).status(), 200)
    await visibleTokens(f.panel).waitFor()
    assert.deepEqual(f.posts, [submitted])
    assert.equal(f.authPosts.length, 0)
    assert.equal(await reauthDialog(f.page).count(), 0)
    assert.equal((await facts(f.id)).audits.length, 1)
  } finally {
    await f.context.close()
  }
}
async function heldLifecycle(replace) {
  // Both rows must exist before the page loads its connection collection.
  const f = await fixture(true, replace)
  let release,
    authCalls = 0
  try {
    const before = await facts(f.id)
    await startDenied(f)
    const authStarted = deferred()
    const gate = deferred()
    const delivered = f.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/reauth')
    void delivered.catch(() => {})
    release = gate.release
    await f.page.route('**/api/auth/reauth', async (route) => {
      authCalls++
      const response = await route.fetch()
      assert.equal(response.status(), 200)
      authStarted.release()
      await gate.promise
      await route.fulfill({ response }).catch(() => {})
    })
    await reauthDialog(f.page).getByLabel('登录密码', { exact: true }).fill(password)
    await reauthDialog(f.page).getByRole('button', { name: '验证', exact: true }).click()
    stage = 'real authentication response held'
    await within(authStarted.promise, 'real reauthentication response held')
    // Explicit lifecycle control: invoke the real outer close handler despite
    // modal inertness. This removes the panel while its delivered auth response
    // is held; it is not presented as an ordinary user click through a modal.
    const outer = f.page.getByRole('dialog').filter({ has: f.panel })
    stage = 'unmount original panel'
    // The outer dialog header comes before the nested reauthentication dialog.
    await outer
      .getByRole('button', { name: '关闭', exact: true })
      .first()
      .evaluate((button) => button.click())
    await f.panel.waitFor({ state: 'detached' })
    if (replace) {
      stage = 'open replacement panel'
      await f.page.getByLabel('搜索供应商、项目或连接 ID', { exact: true }).fill(f.replacement)
      await f.page.getByRole('button', { name: /^(配置与详情|查看记录)$/ }).click()
      await f.page.getByRole('region', { name: '本地连接器配置', exact: true }).waitFor()
    }
    const refreshed = f.page.waitForResponse(
      async (response) =>
        new URL(response.url()).pathname === '/api/auth/session' &&
        response.status() === 200 &&
        (await response.json()).freshAuth === true,
    )
    void refreshed.catch(() => {})
    release()
    stage = 'obsolete panel cannot retry'
    assert.equal((await delivered).status(), 200)
    await refreshed
    // A real browser task barrier observes completion after the held promise.
    await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(authCalls, 1)
    assert.equal(f.posts.length, 1)
    assert.equal(f.allConfigurePosts.length, 1)
    assert.equal(isDeepStrictEqual(await facts(f.id), before), true)
    assert.equal(
      await f.page
        .locator('code')
        .filter({ hasText: /^nxpair_/ })
        .count(),
      0,
    )
  } finally {
    release?.()
    await f.context.close()
  }
}

async function startRevokeDenied(f) {
  const before = await facts(f.id)
  assert.equal(before.connector_identities.filter((row) => row.connection_id === f.id && !row.revoked_at).length, 1)
  assert.equal(before.connector_leases.filter((row) => row.connection_id === f.id && !row.revoked_at).length, 1)
  assert.equal(before.channels.filter((row) => row.metadata?.connection_id === f.id && row.enabled).length, 1)
  const response = f.page.waitForResponse(
    (response) => new URL(response.url()).pathname === f.revokePath && response.request().method() === 'DELETE',
  )
  void response.catch(() => {})
  await confirmRevoke(f.page).click()
  stage = 'real stale revocation denial'
  const denied = await response
  assert.equal(denied.status(), 401)
  assert.equal((await denied.json()).error?.code, 'forbidden')
  assert.equal(isDeepStrictEqual(await facts(f.id), before), true)
  assert.deepEqual(f.deletes, [f.revokePath])
  observations.push({ revokeStatus: 401, deleteRequests: 1, connectorFactsUnchanged: true, revokeAuditDelta: 0 })
  stage = 'revocation reauthentication dialog'
  await reauthDialog(f.page).waitFor({ state: 'visible', timeout: oldRevokeUI ? 3000 : 10000 })
  return before
}

async function revokedOnce(f, before) {
  const after = await facts(f.id)
  const connection = after.owned_connections.find((row) => row.id === f.id)
  assert.equal(connection.status, 'revoked')
  assert.ok(connection.revoked_at)
  for (const table of ['connector_identities', 'connector_leases']) {
    const rows = after[table].filter((row) => row.connection_id === f.id)
    assert.equal(rows.length, 1)
    assert.ok(rows[0].revoked_at)
  }
  assert.equal(after.connector_pairings.filter((row) => row.connection_id === f.id).length, 0)
  const channels = after.channels.filter((row) => row.metadata?.connection_id === f.id)
  assert.equal(channels.length, 1)
  assert.equal(channels[0].enabled, false)
  assert.equal(isDeepStrictEqual(after.provider_credentials, before.provider_credentials), true)
  for (const table of [
    'owned_connections',
    'channels',
    'connector_pairings',
    'connector_identities',
    'connector_leases',
  ]) {
    const unrelated = (rows) =>
      rows.filter(
        (row) =>
          (table === 'owned_connections'
            ? row.id
            : table === 'channels'
              ? row.metadata?.connection_id
              : row.connection_id) !== f.id,
      )
    assert.equal(isDeepStrictEqual(unrelated(after[table]), unrelated(before[table])), true)
  }
  assert.equal(after.audits.filter((row) => row.action === 'connection.revoked').length, 1)
  assert.equal(before.audits.filter((row) => row.action === 'connection.revoked').length, 0)
  observations.push({
    connectionRevoked: true,
    identitiesRevoked: 1,
    leasesRevoked: 1,
    disabledChannels: 1,
    revokeAuditDelta: 1,
  })
}

async function revokeCancel() {
  const f = await fixture(true, false, 'revoke')
  try {
    const before = await startRevokeDenied(f)
    await reauthDialog(f.page).getByRole('button', { name: '取消', exact: true }).click()
    await reauthDialog(f.page).waitFor({ state: 'hidden' })
    stage = 'cancel preserves active connector'
    assert.deepEqual(f.deletes, [f.revokePath])
    assert.equal(f.authPosts.length, 0)
    assert.equal(isDeepStrictEqual(await facts(f.id), before), true)
    assert.equal(await confirmRevoke(f.page).isEnabled(), true)
    await revokeDialog(f.page).getByRole('button', { name: '取消', exact: true }).click()
    await revokeDialog(f.page).waitFor({ state: 'hidden' })
    assert.equal(isDeepStrictEqual(await facts(f.id), before), true)
  } finally {
    await f.context.close()
  }
}

async function revokeReauth() {
  // A second connection already exists when the collection loads. The actual
  // pending DELETE must keep the selected ID and leave the second row untouched.
  const f = await fixture(true, true, 'revoke')
  try {
    const before = await startRevokeDenied(f)
    const retried = f.page.waitForResponse(
      (response) => new URL(response.url()).pathname === f.revokePath && response.request().method() === 'DELETE',
    )
    void retried.catch(() => {})
    await reauthDialog(f.page).getByLabel('登录密码', { exact: true }).fill(password)
    await reauthDialog(f.page).getByRole('button', { name: '验证', exact: true }).click()
    stage = 'real revocation session rotation and original retry'
    assert.equal((await retried).status(), 200)
    await revokeDialog(f.page).waitFor({ state: 'hidden' })
    assert.deepEqual(f.deletes, [f.revokePath, f.revokePath])
    assert.equal(f.authPosts.length, 1)
    const current = (await f.context.cookies()).find((cookie) => cookie.name === 'nexus_session')?.value
    assert.ok(current && current !== f.cookie)
    assert.ok((await db.query('SELECT revoked_at FROM sessions WHERE id=$1', [f.sessionId])).rows[0].revoked_at)
    assert.equal((await (await f.context.request.get(origin + '/api/auth/session')).json()).freshAuth, true)
    await revokedOnce(f, before)
  } finally {
    await f.context.close()
  }
}

async function revokeFresh() {
  const f = await fixture(false, false, 'revoke')
  try {
    const before = await facts(f.id)
    const response = f.page.waitForResponse(
      (response) => new URL(response.url()).pathname === f.revokePath && response.request().method() === 'DELETE',
    )
    void response.catch(() => {})
    await confirmRevoke(f.page).click()
    stage = 'fresh single connection revocation'
    assert.equal((await response).status(), 200)
    await revokeDialog(f.page).waitFor({ state: 'hidden' })
    assert.deepEqual(f.deletes, [f.revokePath])
    assert.equal(f.authPosts.length, 0)
    assert.equal(await reauthDialog(f.page).count(), 0)
    await revokedOnce(f, before)
  } finally {
    await f.context.close()
  }
}

async function revokeHeldLifecycle(replace) {
  const f = await fixture(true, replace, 'revoke')
  let release,
    authCalls = 0
  try {
    const before = await startRevokeDenied(f)
    const authStarted = deferred()
    const gate = deferred()
    const delivered = f.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/reauth')
    void delivered.catch(() => {})
    release = gate.release
    await f.page.route('**/api/auth/reauth', async (route) => {
      authCalls++
      const response = await route.fetch()
      assert.equal(response.status(), 200)
      authStarted.release()
      await gate.promise
      await route.fulfill({ response }).catch(() => {})
    })
    await reauthDialog(f.page).getByLabel('登录密码', { exact: true }).fill(password)
    await reauthDialog(f.page).getByRole('button', { name: '验证', exact: true }).click()
    stage = 'real revocation authentication response held'
    await within(authStarted.promise, 'real revocation authentication response held')
    // Explicit lifecycle control invokes the real outer close handler despite
    // the nested modal's inertness. Authorization and authentication stay real.
    await revokeDialog(f.page)
      .getByRole('button', { name: '关闭', exact: true })
      .first()
      .evaluate((button) => button.click())
    await revokeDialog(f.page).waitFor({ state: 'detached' })
    if (replace) {
      stage = 'open replacement revocation confirmation'
      await f.page.getByLabel('搜索供应商、项目或连接 ID', { exact: true }).fill(f.replacement)
      await f.page.getByRole('button', { name: '撤销连接', exact: true }).click()
      await revokeDialog(f.page).waitFor()
    }
    const refreshed = f.page.waitForResponse(
      async (response) =>
        new URL(response.url()).pathname === '/api/auth/session' &&
        response.status() === 200 &&
        (await response.json()).freshAuth === true,
    )
    void refreshed.catch(() => {})
    release()
    stage = 'obsolete confirmation cannot revoke any connection'
    assert.equal((await delivered).status(), 200)
    await refreshed
    await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(authCalls, 1)
    assert.equal(f.authPosts.length, 1)
    assert.deepEqual(f.deletes, [f.revokePath])
    assert.equal(isDeepStrictEqual(await facts(f.id), before), true)
    if (replace) {
      assert.equal(await confirmRevoke(f.page).isEnabled(), true)
      await revokeDialog(f.page).getByRole('button', { name: '取消', exact: true }).click()
    }
    observations.push({ heldAuthCalls: 1, deleteRequests: 1, connectorFactsUnchanged: true, replacement: replace })
  } finally {
    release?.()
    await f.context.close()
  }
}

try {
  await mkdir(artifacts, { recursive: true })
  stage = 'database fixture'
  assert.equal(
    (await db.query('SELECT current_database() AS name')).rows[0].name,
    'connector_test_reauth_browser_round54',
  )
  stage = 'canonical migrations'
  await db.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  assert.equal((await runMigrations(db)).total, 28)
  stage = 'seed organization'
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })
  await db.query(
    "INSERT INTO organizations(id,tenant_id,name,slug) VALUES('reauth-browser-org','reauth-browser-tenant','Browser reauthentication','reauth-browser-org')",
  )
  stage = 'seed user'
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    user,
    email,
    `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`,
  ])
  stage = 'seed membership'
  await db.query(
    "INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES('reauth-browser-org','reauth-browser-tenant',$1,'admin')",
    [user],
  )
  stage = 'seed project'
  await db.query(
    "INSERT INTO projects(id,tenant_id,organization_id,name) VALUES('reauth-browser-project','reauth-browser-tenant','reauth-browser-org','Browser project')",
  )
  stage = 'isolated app'
  runtime = await mkdtemp(join(artifacts, 'runtime-'))
  // Next's development route scanner does not discover this Windows src
  // junction. Copy public source unchanged; only dependencies are a junction.
  for (const name of ['src', 'packages']) await cp(join(root, name), join(runtime, name), { recursive: true })
  await symlink(
    join(root, 'node_modules'),
    join(runtime, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await writeFile(join(runtime, 'package.json'), await readFile(join(root, 'package.json')))
  await writeFile(join(runtime, 'tsconfig.json'), await readFile(join(root, 'tsconfig.json')))
  await writeFile(join(runtime, 'postcss.config.mjs'), await readFile(join(root, 'postcss.config.mjs')))
  await writeFile(
    join(runtime, 'next.config.mjs'),
    'export default ' +
      JSON.stringify({ output: 'standalone', agentRules: false, distDir: 'next-output', turbopack: { root } }) +
      '\n',
  )
  await writeFile(join(runtime, 'next-env.d.ts'), rootTypes)
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((done) => reservation.close(done))
  origin = 'http://127.0.0.1:' + port
  const environment = {
    NODE_ENV: 'development',
    DATABASE_URL: target.href,
    NEXUS_CONNECTORS_ENABLED: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
  }
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'ComSpec'])
    if (process.env[name] !== undefined) environment[name] = process.env[name]
  nextProcess = spawn(
    process.execPath,
    [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: runtime, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  nextProcess.stdout.on('data', (chunk) => {
    nextOutput += chunk
  })
  nextProcess.stderr.on('data', (chunk) => {
    nextOutput += chunk
  })
  const deadline = Date.now() + 120000
  stage = 'isolated Next readiness'
  let ready = false
  while (!ready && Date.now() < deadline) {
    if (nextProcess.exitCode !== null) throw new Error('isolated Next fixture exited')
    if (nextOutput.includes('Module not found') || nextOutput.includes("Can't resolve"))
      throw new Error('isolated public source dependency missing')
    ready = await fetch(origin + '/api/auth/session', { signal: AbortSignal.timeout(2000) })
      .then((response) => response.ok)
      .catch(() => false)
    if (!ready) await delay(100)
  }
  assert.ok(ready, 'isolated Next fixture ready')
  browser = await chromium.launch({ headless: true })
  if (!revocationOnly) {
    await check('real stale denial then cancel preserves connector facts', staleCancel)
    if (!oldUI) {
      await check('real reauthentication rotates session and retries immutable models once', realReauth)
      await check('fresh session issues once without a reauthentication dialog', freshNormal)
      await check('held authentication completion cannot retry an unmounted panel', () => heldLifecycle(false))
      await check('held authentication completion cannot retry a replaced panel', () => heldLifecycle(true))
    }
  }
  if (!oldUI) {
    await check('real stale revocation denial then cancel preserves active connector facts', revokeCancel)
    if (!oldRevokeUI) {
      await check('real reauthentication rotates session and revokes original connection once', revokeReauth)
      await check('fresh session revokes one connection without reauthentication', revokeFresh)
      await check('held authentication completion cannot revoke an unmounted confirmation', () =>
        revokeHeldLifecycle(false),
      )
      await check('held authentication completion cannot revoke a replacement confirmation', () =>
        revokeHeldLifecycle(true),
      )
    }
  }
  assert.equal(browserErrors.length, 0)
} catch {
  cases.push({ name: 'fixture infrastructure', ok: false, stage })
  console.log('FAIL browser: fixture infrastructure [' + stage + ']')
} finally {
  for (const [name, close] of [
    ['browser closed', () => within(browser?.close() ?? Promise.resolve(), 'Browser shutdown')],
    [
      'isolated Next closed',
      async () => {
        if (nextProcess && nextProcess.exitCode === null) {
          const exited = once(nextProcess, 'exit')
          if (process.platform === 'win32')
            await new Promise((done) =>
              execFile('taskkill', ['/PID', String(nextProcess.pid), '/T', '/F'], { windowsHide: true }, done),
            )
          else nextProcess.kill('SIGTERM')
          await within(exited, 'Next shutdown')
        }
      },
    ],
    // Never restore this file over somebody else's edit.
    [
      'root generated types unchanged',
      async () => assert.equal((await readFile(join(root, 'next-env.d.ts'))).equals(rootTypes), true),
    ],
    ['database client closed', () => within(db.end(), 'Database shutdown', 5000)],
  ]) {
    try {
      await close()
      observations.push({ cleanup: name, ok: true })
    } catch {
      cases.push({ name, ok: false, stage: 'cleanup' })
    }
  }
  await mkdir(artifacts, { recursive: true })
  await writeFile(
    join(
      artifacts,
      oldUI
        ? 'old-ui-report.json'
        : oldRevokeUI
          ? 'old-revoke-ui-report.json'
          : revocationOnly
            ? 'revocation-report.json'
            : 'green-report.json',
    ),
    JSON.stringify({ cases, observations, browserErrors, canonicalMigrations: 28, isolatedNext: true }, null, 2) + '\n',
  )
  // Retain ignored outputs and junctions; never recursively remove directories
  // that can traverse the real source or installed dependency junctions.
}
if (cases.some((item) => !item.ok)) process.exitCode = 1
