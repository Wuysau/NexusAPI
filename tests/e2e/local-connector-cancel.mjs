// Real Chromium + the repository's Next app + PostgreSQL + a loopback mock Gateway.
// Run after local-connector.test.ts with its dedicated connector_test DATABASE_URL.
// The four cancellation cases use the real Next POST route. Success/late-result
// controls explicitly stub only that endpoint; this does not run a Go model.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { chromium } from 'playwright'

const databaseURL = process.env.DATABASE_URL
if (!databaseURL || !new URL(databaseURL).pathname.includes('connector_test'))
  throw new Error('Dedicated connector_test database required')
if (existsSync('.next/dev/lock')) throw new Error('Stop the existing Next dev server before running this suite')

const model = 'cancel-browser-fixture'
const runID = randomBytes(8).toString('hex')
const password = randomBytes(24).toString('base64url')
const apiKey = 'sk-nx-' + randomBytes(24).toString('hex')
const wrongKey = 'sk-nx-' + randomBytes(24).toString('hex')
const secrets = [password, apiKey, wrongKey, databaseURL]
const db = new pg.Client({ connectionString: databaseURL })
const generatedTypes = await readFile('next-env.d.ts', 'utf8')
const failures = []
const browserErrors = []
const fixtureErrors = []
const cases = []
let nextProcess, browser, origin, connectionID, leaseToken, identity, csrf
let nextLogs = ''
let dispatches = 0
let pendingGateway
let owner

function deferred() {
  let resolve
  const promise = new Promise((done) => (resolve = done))
  return { promise, resolve }
}

async function within(promise, label, milliseconds = 5000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function check(name, fn) {
  try {
    await fn()
    cases.push(name)
    console.log('PASS browser: ' + name)
  } catch (error) {
    failures.push(name)
    console.error(
      'FAIL browser: ' +
        name +
        ' — ' +
        secrets.reduce((text, secret) => text.replaceAll(secret, '[fixture]'), error.message),
    )
  }
}

const mockGateway = createServer((request, response) => {
  void handleGateway(request, response).catch(() => {
    fixtureErrors.push('mock Gateway request validation failed')
    if (!response.headersSent) response.writeHead(500)
    response.end('fixture failed')
  })
})

async function handleGateway(request, response) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  dispatches++
  assert.equal(request.url, '/v1/chat/completions')
  assert.equal(request.method, 'POST')
  assert.ok(request.headers.authorization === 'Bearer ' + apiKey, 'project key reaches only the mock Gateway')
  const body = JSON.parse(Buffer.concat(chunks).toString())
  assert.equal(body.model, model)
  assert.equal(body.stream, false)
  const pending = pendingGateway
  if (!pending) return response.writeHead(503).end()
  pending.response = response
  response.on('close', () => pending.closed.resolve(!response.writableFinished))
  if (pending.phase === 'partial_json') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"model":')
    response.flushHeaders()
  }
  pending.received.resolve()
}

async function api(context, path, body, method = 'POST') {
  return context.request.fetch(origin + path, {
    method,
    headers: { 'x-csrf-token': csrf },
    ...(body === undefined ? {} : { data: body }),
  })
}

async function refreshLease() {
  const response = await fetch(origin + '/api/connector/lease', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + identity, 'content-type': 'application/json' },
    body: JSON.stringify({ leaseToken, readyModels: [model] }),
  })
  assert.equal(response.status, 200, 'fixture lease renewal')
  leaseToken = (await response.json()).leaseToken
  secrets.push(leaseToken)
  // Only this fixture lease is marked transport-fresh. No CLI or real model is implied.
  await db.query('UPDATE connector_leases SET transport_seen_at=now() WHERE connection_id=$1', [connectionID])
}

async function openPanel(page) {
  await page.goto(origin + '/connections')
  await page.getByLabel('搜索供应商、项目或连接 ID', { exact: true }).fill(connectionID)
  await page.getByRole('button', { name: /^(配置与详情|查看记录)$/ }).click()
  const panel = page.getByRole('dialog').getByRole('region', { name: '本地连接器配置' })
  await panel.getByRole('heading', { name: 'Ollama 本地连接器', exact: true }).waitFor()
  return panel
}

async function fillTest(panel, key = apiKey) {
  await panel.getByLabel('测试连接器模型', { exact: true }).selectOption(model)
  await panel.getByLabel('连接器测试项目 API Key', { exact: true }).fill(key)
}

const runButton = (panel) => panel.getByRole('button', { name: /^(执行测试调用（产生真实用量）|测试调用进行中…)$/ })
const cancelButton = (panel) => panel.getByRole('button', { name: '取消测试', exact: true })

async function realCancel(page, action, phase) {
  await refreshLease()
  const panel = await openPanel(page)
  await fillTest(panel)
  const before = dispatches
  const pending = { phase, received: deferred(), closed: deferred() }
  pendingGateway = pending
  try {
    await runButton(panel).click()
    await within(pending.received.promise, 'the real Next route must dispatch to the mock Gateway', 15000)
    assert.equal(dispatches - before, 1, 'one real Gateway dispatch')
    const failed = page.waitForEvent('requestfailed', {
      predicate: (request) => request.url().endsWith(`/api/connections/${connectionID}/connector/test`),
      timeout: 5000,
    })
    // Attach a handler immediately so a regression cannot create an unhandled rejection.
    failed.catch(() => {})
    if (action === 'cancel') await cancelButton(panel).click()
    else if (action === 'close')
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
    else await page.keyboard.press('Escape')
    await failed
    assert.equal(await within(pending.closed.promise, 'Gateway connection must close after browser cancellation'), true)
    assert.equal(dispatches - before, 1, 'cancellation must not replay inference')
    if (action === 'cancel') {
      await panel.getByText(/已取消/).waitFor()
      assert.equal(await panel.getByLabel('连接器测试项目 API Key', { exact: true }).inputValue(), '')
      assert.equal(await cancelButton(panel).count(), 0)
      assert.equal(await panel.getByRole('alert').count(), 0)
      if (phase === 'before_headers') {
        await mkdir('output/playwright', { recursive: true })
        await page.screenshot({ path: 'output/playwright/local-connector-cancel.png', fullPage: true })
      }
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
    }
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
  } finally {
    pending.response?.destroy()
    pendingGateway = undefined
  }
}

try {
  await db.connect()
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })
  for (const role of ['owner', 'viewer']) {
    await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      `cancel-${role}-${runID}`,
      `cancel-${role}-${runID}@example.invalid`,
      `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`,
    ])
    await db.query('INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES($1,$2,$3,$4)', [
      'connector-org',
      'connector-tenant',
      `cancel-${role}-${runID}`,
      role,
    ])
  }
  for (const [key, project, suffix] of [
    [apiKey, 'connector-project', 'valid'],
    [wrongKey, 'other-project', 'wrong'],
  ]) {
    await db.query(
      `INSERT INTO downstream_api_keys(id,tenant_id,organization_id,project_id,name,hash,prefix,scopes)
       VALUES($1,'connector-tenant','connector-org',$2,$1,$3,'sk-nx','["chat:write"]')`,
      [`cancel-key-${suffix}-${runID}`, project, createHash('sha256').update(key).digest('hex')],
    )
  }
  await db.query(
    "INSERT INTO project_memberships(tenant_id,project_id,user_id,role) VALUES('connector-tenant','connector-project',$1,'viewer')",
    [`cancel-viewer-${runID}`],
  )
  mockGateway.listen(0, '127.0.0.1')
  await once(mockGateway, 'listening')
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((done) => reservation.close(done))
  origin = 'http://127.0.0.1:' + port
  nextProcess = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DATABASE_URL: databaseURL,
        NEXUS_CONNECTORS_ENABLED: 'true',
        NEXUS_GATEWAY_URL: 'http://127.0.0.1:' + mockGateway.address().port,
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  )
  nextProcess.stdout.on('data', (chunk) => (nextLogs += chunk))
  nextProcess.stderr.on('data', (chunk) => (nextLogs += chunk))
  const deadline = Date.now() + 120000
  let ready = false
  while (Date.now() < deadline && !ready) {
    if (nextProcess.exitCode !== null) throw new Error('Next fixture exited before readiness')
    ready = await fetch(origin + '/api/auth/session', { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false)
    if (!ready) await delay(100)
  }
  assert.ok(ready, 'Next fixture startup')
  browser = await chromium.launch({ headless: true })
  owner = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  owner.setDefaultTimeout(10000)
  const login = await owner.request.post(origin + '/api/auth/login', {
    data: { email: `cancel-owner-${runID}@example.invalid`, password },
  })
  assert.equal(login.status(), 200, 'fixture owner login')
  csrf = (await owner.cookies()).find((cookie) => cookie.name === 'nexus_csrf').value
  const created = await api(owner, '/api/connections', {
    provider: 'ollama',
    mode: 'local_sidecar',
    projectId: 'connector-project',
  })
  assert.equal(created.status(), 201, 'fixture connection creation')
  connectionID = (await created.json()).connection.id
  const configured = await api(owner, `/api/connections/${connectionID}/connector`, { models: [model] })
  assert.equal(configured.status(), 200, 'fixture model configuration')
  const pairing = (await configured.json()).pairingToken
  secrets.push(pairing)
  const paired = await fetch(origin + '/api/connector/pair', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + pairing },
  })
  assert.equal(paired.status, 200, 'fixture connector pairing')
  identity = (await paired.json()).credential
  secrets.push(identity)
  await refreshLease()
  const page = await owner.newPage()
  page.on('pageerror', (error) => browserErrors.push(error.message))

  for (const [action, phase] of [
    ['cancel', 'before_headers'],
    ['cancel', 'partial_json'],
    ['close', 'before_headers'],
    ['escape', 'partial_json'],
  ])
    await check(`real Next → mock Gateway: ${action}, ${phase}`, () => realCancel(page, action, phase))

  const testPath = `**/api/connections/${connectionID}/connector/test`
  await check('reopen after unmount and complete a controlled UI success', async () => {
    await refreshLease()
    await page.route(testPath, (route) => route.fulfill({ json: { message: '受控界面成功', requestId: 'ui-success' } }))
    const before = dispatches
    const panel = await openPanel(page)
    await fillTest(panel)
    const statePath = `**/api/connections/${connectionID}/connector`
    const state = await (await owner.request.get(origin + `/api/connections/${connectionID}/connector`)).json()
    const refreshStarted = deferred()
    const releaseRefresh = deferred()
    await page.route(statePath, async (route) => {
      refreshStarted.resolve()
      await releaseRefresh.promise
      await route.fulfill({ json: state })
    })
    try {
      await runButton(panel).click()
      await panel.getByText('受控界面成功 请求 ID：ui-success', { exact: true }).waitFor()
      await within(refreshStarted.promise, 'success starts background state refresh')
      assert.equal(await panel.getByLabel('连接器测试项目 API Key', { exact: true }).inputValue(), '')
      assert.equal(await cancelButton(panel).count(), 0)
      assert.equal(await runButton(panel).textContent(), '执行测试调用（产生真实用量）')
      assert.equal(
        await panel.getByRole('button', { name: '保存模型并生成一次性配对令牌 / 轮换身份', exact: true }).isEnabled(),
        true,
        'completed test releases busy state while refresh remains pending',
      )
      assert.equal(dispatches, before, 'UI success is explicitly stubbed, not a Gateway inference')
    } finally {
      releaseRefresh.resolve()
      await page.unroute(statePath)
      await page.unroute(testPath)
    }
  })

  await check('late canceled promise cannot overwrite or unlock a newer test', async () => {
    await refreshLease()
    let calls = 0
    const second = deferred()
    const secondReceived = deferred()
    await page.route(testPath, async (route) => {
      calls++
      if (calls === 2) {
        secondReceived.resolve()
        await second.promise
      }
      await route.fulfill({
        json: { message: calls === 1 ? '旧界面结果' : '新界面结果', requestId: calls === 1 ? 'old-ui' : 'new-ui' },
      })
    })
    const panel = await openPanel(page)
    // Delegate to real browser fetch and consume the stub response, then delay
    // delivering that already-completed result. This intentionally ignores abort
    // only at the promise boundary to exercise stale-result guards deterministically.
    await page.evaluate((suffix) => {
      const nativeFetch = window.fetch.bind(window)
      let first = true
      window.__cancelResultGateReady = false
      window.__cancelResultGateReleased = false
      const gate = new Promise((resolve) => (window.__releaseCancelResult = resolve))
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args)
        if (first && String(args[0]).endsWith(suffix)) {
          first = false
          const text = await response.text()
          window.__cancelResultGateReady = true
          await gate
          window.__cancelResultGateReleased = true
          return new Response(text, { status: response.status, headers: response.headers })
        }
        return response
      }
    }, `/api/connections/${connectionID}/connector/test`)
    try {
      await fillTest(panel)
      await runButton(panel).click()
      await page.waitForFunction(() => window.__cancelResultGateReady)
      await cancelButton(panel).click()
      await fillTest(panel)
      await runButton(panel).click()
      await within(secondReceived.promise, 'new test must start before releasing old result')
      await page.evaluate(() => window.__releaseCancelResult())
      await page.waitForFunction(() => window.__cancelResultGateReleased)
      assert.equal(await runButton(panel).isDisabled(), true, 'old finally must not unlock the newer request')
      assert.equal(await cancelButton(panel).count(), 1)
      assert.equal(await panel.getByLabel('连接器测试项目 API Key', { exact: true }).inputValue(), apiKey)
      assert.equal(await panel.getByText(/旧界面结果|old-ui/).count(), 0)
      second.resolve()
      await panel.getByText('新界面结果 请求 ID：new-ui', { exact: true }).waitFor()
      assert.equal(await panel.getByText(/旧界面结果|old-ui/).count(), 0)
      assert.equal(calls, 2)
    } finally {
      second.resolve()
      await page.unroute(testPath)
      await page.reload()
    }
  })

  await check('wrong-project key remains denied without Gateway dispatch', async () => {
    await refreshLease()
    const before = dispatches
    const panel = await openPanel(page)
    await fillTest(panel, wrongKey)
    await runButton(panel).click()
    await panel.getByRole('alert').filter({ hasText: 'API Key 未获此连接项目的调用授权' }).waitFor()
    assert.equal(await panel.getByLabel('连接器测试项目 API Key', { exact: true }).inputValue(), '')
    assert.equal(await cancelButton(panel).count(), 0)
    assert.equal(dispatches, before)
  })

  await check('viewer sees authorized testing but cannot manage connector pairing', async () => {
    const context = await browser.newContext()
    context.setDefaultTimeout(10000)
    try {
      const login = await context.request.post(origin + '/api/auth/login', {
        data: { email: `cancel-viewer-${runID}@example.invalid`, password },
      })
      assert.equal(login.status(), 200)
      const page = await context.newPage()
      const panel = await openPanel(page)
      assert.equal(
        await panel.getByRole('button', { name: '保存模型并生成一次性配对令牌 / 轮换身份', exact: true }).count(),
        0,
      )
      assert.equal(await runButton(panel).count(), 1)
      assert.equal(await cancelButton(panel).count(), 0)
      const viewerCSRF = (await context.cookies()).find((cookie) => cookie.name === 'nexus_csrf').value
      const denied = await context.request.post(origin + `/api/connections/${connectionID}/connector`, {
        headers: { 'x-csrf-token': viewerCSRF },
        data: { models: [model] },
      })
      assert.equal(denied.status(), 403)
    } finally {
      await context.close()
    }
  })

  await check('revoked connection exposes neither testing nor cancel controls', async () => {
    const revoked = await api(owner, '/api/connections/' + connectionID, undefined, 'DELETE')
    assert.equal(revoked.status(), 200)
    const panel = await openPanel(page)
    await panel.getByText('已撤销', { exact: true }).waitFor()
    assert.equal(await runButton(panel).count(), 0)
    assert.equal(await cancelButton(panel).count(), 0)
    assert.equal(await panel.getByLabel('连接器测试项目 API Key', { exact: true }).count(), 0)
  })
  assert.deepEqual(browserErrors, [], 'no uncaught browser errors')
  assert.deepEqual(fixtureErrors, [], 'no mock Gateway handler errors')
  assert.equal(
    (await db.query('SELECT count(*)::int AS count FROM attempts WHERE connection_id=$1', [connectionID])).rows[0]
      .count,
    0,
    'mock Gateway and UI controls must not invent usage records',
  )
  assert.equal(dispatches, 4, 'exactly four real canceled Gateway requests')
  assert.deepEqual(failures, [])
  console.log(`PASS ${cases.length} browser groups; 4 real canceled Next→mock Gateway dispatches; no fake usage`)
} finally {
  await browser?.close()
  mockGateway.closeAllConnections()
  if (mockGateway.listening) await new Promise((done) => mockGateway.close(done))
  if (nextProcess && nextProcess.exitCode === null) {
    if (process.platform === 'win32')
      await new Promise((done) =>
        execFile('taskkill', ['/PID', String(nextProcess.pid), '/T', '/F'], { windowsHide: true }, done),
      )
    else {
      nextProcess.kill('SIGTERM')
      await within(once(nextProcess, 'exit'), 'Next fixture shutdown')
    }
  }
  // Next dev only changes generated import locations here; preserve unrelated edits.
  const currentTypes = await readFile('next-env.d.ts', 'utf8')
  if (currentTypes.replaceAll('/dev/types/', '/types/') === generatedTypes)
    await writeFile('next-env.d.ts', generatedTypes)
  await mkdir('.test-artifacts/resilience/r28-console-cancel', { recursive: true })
  for (const secret of secrets) nextLogs = nextLogs.replaceAll(secret, '[fixture]')
  await writeFile(resolve('.test-artifacts/resilience/r28-console-cancel/next.log'), nextLogs)
  // Disable only this run's synthetic keys; historical fixture rows remain inspectable.
  if (connectionID)
    await db.query('UPDATE connector_leases SET revoked_at=now(),transport_seen_at=NULL WHERE connection_id=$1', [
      connectionID,
    ])
  await db
    .query('UPDATE downstream_api_keys SET enabled=false WHERE id=ANY($1::text[])', [
      [`cancel-key-valid-${runID}`, `cancel-key-wrong-${runID}`],
    ])
    .catch(() => {})
  await db.end()
}
