// Read-only browser acceptance for an already seeded disposable Control Plane.
// Canary stays in this Node process. No raw logs, bodies, traces, screenshots,
// cookies, browser storage or exception messages are written to artifacts.
import { chromium } from 'playwright'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

const origin = process.env.TEST_ORIGIN ?? 'http://127.0.0.1:3320'
const url = new URL(origin)
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:')
  throw new Error('Local fixture origin required')
const receiptPath = resolve(process.env.SECRET_BROWSER_RECEIPT ?? 'output/playwright/secret-plane-browser.json')
const canary = await readFile(resolve('.test-artifacts/vault-reference/runtime/expected-canary'))
if (canary.length < 32) throw new Error('Real enrollment fixture canary required')
const variants = [
  ...new Set([
    canary.toString('utf8'),
    canary.toString('base64'),
    canary.toString('hex'),
    encodeURIComponent(canary.toString('utf8')),
  ]),
]
const containsCanary = (value) => variants.some((secret) => String(value).includes(secret))
const counts = {
  responseBodies: 0,
  responseHeaders: 0,
  requestBodies: 0,
  requestHeaders: 0,
  documentBodies: 0,
  consoleMessages: 0,
  browserErrors: 0,
  serverLogChunks: 0,
  leaks: 0,
  unreadableResponses: 0,
}
const checks = {
  detectorPositiveControl: containsCanary(canary.toString('utf8')),
  ownerLogin: false,
  viewerLogin: false,
  ownerChannels: false,
  viewerChannels: false,
  opaqueCredentialForm: false,
  noPlaintextIntake: false,
  channelsAPI: false,
  retiredSecretEndpoint: false,
  noCanary: false,
  serverStopped: false,
}
let stage = 'startup',
  server,
  browser,
  succeeded = false
const pending = new Set()
const logTails = new Map()
function scan(value, category) {
  counts[category]++
  if (containsCanary(value)) counts.leaks++
}
function track(promise) {
  pending.add(promise)
  promise.finally(() => pending.delete(promise))
}
async function drain() {
  while (pending.size) await Promise.all([...pending])
}
function attach(page) {
  page.on('console', (message) => {
    scan(message.text(), 'consoleMessages')
    track(
      Promise.all(
        message.args().map(async (arg) => {
          try {
            scan(JSON.stringify(await arg.jsonValue()), 'consoleMessages')
          } catch {
            /* Closed execution contexts have already supplied message.text(). */
          }
        }),
      ),
    )
  })
  page.on('pageerror', (error) => scan(error.message, 'browserErrors'))
  page.on('request', (request) => {
    scan(request.url(), 'requestHeaders')
    scan(JSON.stringify(request.headers()), 'requestHeaders')
    const body = request.postData()
    if (body !== null) scan(body, 'requestBodies')
  })
  page.on('response', (response) =>
    track(
      (async () => {
        scan(JSON.stringify(await response.allHeaders()), 'responseHeaders')
        if ([204, 304].includes(response.status()) || (response.status() >= 300 && response.status() < 400)) return
        try {
          scan((await response.body()).toString('utf8'), 'responseBodies')
        } catch {
          counts.unreadableResponses++
        }
      })().catch(() => {
        counts.unreadableResponses++
      }),
    ),
  )
}
async function inspectDocument(page) {
  scan(await page.content(), 'documentBodies')
}
async function login(email, password) {
  if (!password) throw new Error('Fixture login password required')
  const context = await browser.newContext()
  const page = await context.newPage()
  attach(page)
  await page.goto(origin + '/channels', { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '登录控制台' }).waitFor()
  await inspectDocument(page)
  await page.locator('input[name="email"]').fill(email)
  await page.locator('input[name="password"]').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('heading', { name: '渠道管理', exact: true }).waitFor({ timeout: 30000 })
  await page.waitForLoadState('networkidle')
  await inspectDocument(page)
  return { context, page }
}
try {
  if (process.argv.includes('--start-server')) {
    if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== '/convergence_e2e18')
      throw new Error('Disposable seeded database required')
    server = spawn(
      process.execPath,
      ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', url.port || '3320'],
      { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    for (const [name, stream] of [
      ['stdout', server.stdout],
      ['stderr', server.stderr],
    ])
      stream.on('data', (chunk) => {
        const text = (logTails.get(name) || '') + chunk.toString('utf8')
        scan(text, 'serverLogChunks')
        logTails.set(name, text.slice(-256))
      })
    let ready = false
    for (let i = 0; i < 90; i++) {
      if (server.exitCode !== null) throw new Error('Fixture server exited')
      try {
        const response = await fetch(origin + '/api/auth/session')
        scan(await response.text(), 'responseBodies')
        if (response.status < 500) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (!ready) throw new Error('Fixture server startup timed out')
  }
  stage = 'browser-launch'
  browser = await chromium.launch({ headless: true })
  stage = 'owner-login'
  const owner = await login(process.env.DEV_ADMIN_EMAIL ?? 'dev@nexus.local', process.env.DEV_ADMIN_PASSWORD)
  checks.ownerLogin = true
  checks.ownerChannels = true
  stage = 'credential-form'
  await owner.page.getByRole('button', { name: '添加渠道', exact: true }).click()
  checks.opaqueCredentialForm = await owner.page.locator('input[name="credentialId"]').isVisible()
  checks.noPlaintextIntake =
    (await owner.page.locator('input[name="secret"],input[name="apiKey"],input[name="password"]').count()) === 0
  await inspectDocument(owner.page)
  stage = 'browser-api'
  // Browser-authenticated fetches exercise the actual network boundary; no
  // canary value or expected comparison value is ever passed into evaluate.
  const apiStatuses = await owner.page.evaluate(async () => {
    const channels = await fetch('/api/channels')
    await channels.text()
    const retired = await fetch('/api/internal/gateway/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_id: 'fixture-tenant', credential_id: 'fixture-credential' }),
    })
    const body = await retired.json()
    return { channels: channels.status, retired: retired.status, retiredCode: body.error?.code }
  })
  checks.channelsAPI = apiStatuses.channels === 200
  checks.retiredSecretEndpoint = apiStatuses.retired === 410 && apiStatuses.retiredCode === 'secret_workload_moved'
  stage = 'viewer-login'
  const viewer = await login('viewer@nexus.local', process.env.DEV_VIEWER_PASSWORD)
  checks.viewerLogin = true
  checks.viewerChannels = true
  await drain()
  await owner.context.close()
  await viewer.context.close()
  checks.noCanary =
    counts.leaks === 0 && counts.unreadableResponses === 0 && counts.responseBodies > 0 && counts.documentBodies >= 5
  succeeded = Object.entries(checks)
    .filter(([key]) => key !== 'serverStopped')
    .every(([, value]) => value)
  stage = succeeded ? 'complete' : 'assertions'
} catch {
  succeeded = false
} finally {
  if (browser) await browser.close().catch(() => {})
  if (server && server.exitCode === null) {
    try {
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      else server.kill('SIGTERM')
    } catch {}
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ])
  }
  checks.serverStopped = !server || server.exitCode !== null || server.signalCode !== null
  checks.noCanary = checks.noCanary && counts.leaks === 0
  succeeded = succeeded && checks.serverStopped && checks.noCanary
  canary.fill(0)
  const receipt = {
    format: 'nexus.secret-plane.browser.fixture.v1',
    recordedAt: new Date().toISOString(),
    passed: succeeded,
    stage,
    checks,
    counts,
    limitations: [
      'Local seeded Control Plane with real Vault-enrollment canary held only by the verifier; no production browser/deployment assertion.',
      'No raw trace, screenshot, network body, console log or storage artifact is retained; receipts contain only fixed labels, booleans and counts.',
      'This read-only browser check does not reenroll credentials or reset fixture databases.',
    ],
  }
  await mkdir(dirname(receiptPath), { recursive: true })
  const serializedReceipt = JSON.stringify(receipt, null, 2)
  if (containsCanary(serializedReceipt)) throw new Error('Receipt sanitization failed')
  await writeFile(receiptPath, serializedReceipt + '\n')
  console.log(serializedReceipt)
  if (!succeeded) process.exitCode = 1
}
