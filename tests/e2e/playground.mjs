// Real React component/browser behavior with explicit fixture HTTP responses.
// Server authorization and Gateway/Worker evidence live in native integration suites.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const key = 'sk-nx-DO-NOT-USE-playground-fixture-0123456789'
function reply(text, requestId = 'browser-request', extra = {}) {
  return {
    version: 1,
    model: 'browser-model',
    requestId,
    assistant: { content: text, refusal: null },
    finishReason: 'stop',
    usage: { inputTokens: '0', outputTokens: null, cachedInputTokens: null, reasoningTokens: null, totalTokens: null },
    canContinue: true,
    ...extra,
  }
}

/** Also imported by the normal Next E2E runner; only these dedicated fixture APIs are intercepted. */
export async function playgroundE2E(page, origin, path = '/playground') {
  const browserErrors = []
  const onError = (error) => browserErrors.push(error.message)
  page.on('pageerror', onError)
  const calls = []
  let behavior = 'normal',
    sequence = 0
  await page.route('**/api/projects?status=active', (route) =>
    route.fulfill({
      json: {
        projects: [
          { id: 'browser-project-a', name: 'Browser A', status: 'active' },
          { id: 'browser-project-b', name: 'Browser B', status: 'active' },
        ],
      },
    }),
  )
  await page.route('**/api/playground/models', (route) => {
    calls.push({ operation: 'models', input: route.request().postDataJSON() })
    return route.fulfill({ json: { version: 1, models: [{ id: 'browser-model' }], requestId: null } })
  })
  await page.route('**/api/playground/chat', (route) => {
    const input = route.request().postDataJSON()
    calls.push({ operation: 'chat', input })
    sequence++
    if (behavior === 'malformed')
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"PRIVATE_FIXTURE_DIAGNOSTIC":' })
    const semantic = behavior === 'semantic'
    return route.fulfill({
      headers: behavior.startsWith('gate') ? { 'x-playground-fixture-gate': behavior } : {},
      json: reply(
        `浏览器回复 ${sequence}`,
        `browser-request-${sequence}`,
        semantic ? { assistant: { content: '可见文本', refusal: '' }, canContinue: false } : {},
      ),
    })
  })
  try {
    await page.goto(origin + path, { waitUntil: 'networkidle' })
    const panel = page.getByRole('region', { name: '项目在线调试' })
    await panel.getByLabel('调试项目', { exact: true }).selectOption('browser-project-a')
    const keyInput = panel.getByLabel('调试项目 API Key', { exact: true })
    const message = panel.getByLabel('调试消息', { exact: true })
    const send = panel.getByRole('button', { name: '发送（产生真实用量）', exact: true })
    const discover = panel.getByRole('button', { name: '获取可用模型', exact: true })
    const clear = panel.getByRole('button', { name: '清空对话', exact: true })
    await keyInput.fill(key)
    await discover.click()
    await panel.getByLabel('调试模型', { exact: true }).selectOption('browser-model')
    await message.fill('浏览器第一轮')
    await send.click()
    await panel.getByText('浏览器回复 1', { exact: true }).waitFor()
    assert.equal(
      await panel.getByRole('link', { name: 'browser-request-1' }).getAttribute('href'),
      '/logs?requestId=browser-request-1',
    )
    assert.match(await panel.innerText(), /输入 0 · 输出 未知/)
    await message.fill('浏览器第二轮')
    await send.click()
    await panel.getByText('浏览器回复 2', { exact: true }).waitFor()
    assert.deepEqual(calls.filter((call) => call.operation === 'chat')[1].input.messages, [
      { role: 'user', content: '浏览器第一轮' },
      { role: 'assistant', content: '浏览器回复 1' },
      { role: 'user', content: '浏览器第二轮' },
    ])
    assert.equal(calls.length, 3, 'one discovery and one dispatch per explicit turn')

    // Consume real browser fetch responses, then gate result delivery after body parsing.
    // Ignoring abort only at this promise boundary deterministically proves stale result guards.
    await page.evaluate(() => {
      window.__playgroundNativeFetch = window.fetch.bind(window)
      window.__playgroundGates = {}
      window.fetch = async (...args) => {
        const response = await window.__playgroundNativeFetch(...args)
        const label = response.headers.get('x-playground-fixture-gate')
        if (label) {
          const read = response.json.bind(response)
          response.json = async () => {
            const body = await read()
            const gate = { ready: true, delivered: false }
            window.__playgroundGates[label] = gate
            await new Promise((resolve) => {
              gate.release = resolve
            })
            gate.delivered = true
            return body
          }
        }
        return response
      }
    })
    await clear.click()
    behavior = 'gate-old'
    await message.fill('被取消的旧消息')
    await send.click()
    await page.waitForFunction(() => window.__playgroundGates['gate-old']?.ready)
    await panel.getByRole('button', { name: '取消调用', exact: true }).click()
    await panel.getByText(/已取消；调用可能已产生用量/).waitFor()
    assert.equal(await message.inputValue(), '')
    behavior = 'gate-new'
    await message.fill('明确发送的新消息')
    await send.click()
    await page.waitForFunction(() => window.__playgroundGates['gate-new']?.ready)
    await page.evaluate(() => window.__playgroundGates['gate-old'].release())
    await page.waitForFunction(() => window.__playgroundGates['gate-old'].delivered)
    assert.equal(await send.isDisabled(), true, 'old finally cannot unlock the new request')
    assert.equal(await panel.getByText('浏览器回复 3', { exact: true }).count(), 0)
    await page.evaluate(() => window.__playgroundGates['gate-new'].release())
    await panel.getByText('浏览器回复 4', { exact: true }).waitFor()
    assert.deepEqual(
      calls.filter((call) => call.operation === 'chat').at(-1).input.messages,
      [{ role: 'user', content: '明确发送的新消息' }],
      'canceled pending turn is never replayed',
    )

    behavior = 'gate-project'
    await message.fill('跨项目旧消息')
    await send.click()
    await page.waitForFunction(() => window.__playgroundGates['gate-project']?.ready)
    await panel.getByLabel('调试项目', { exact: true }).selectOption('browser-project-b')
    assert.equal(await keyInput.inputValue(), '')
    assert.equal(await message.inputValue(), '')
    assert.equal(await panel.getByRole('link', { name: 'browser-request-4' }).count(), 0)
    await page.evaluate(() => window.__playgroundGates['gate-project'].release())
    await page.waitForFunction(() => window.__playgroundGates['gate-project'].delivered)
    assert.equal(await panel.getByText('浏览器回复 5', { exact: true }).count(), 0)

    behavior = 'normal'
    await keyInput.fill(key)
    await discover.click()
    await message.fill('换 Key 前消息')
    await send.click()
    await panel.getByText('浏览器回复 6', { exact: true }).waitFor()
    await keyInput.fill(key + '-new')
    assert.equal(await panel.getByText('浏览器回复 6', { exact: true }).count(), 0)
    assert.equal(await message.inputValue(), '')
    assert.equal(await panel.getByLabel('调试模型', { exact: true }).inputValue(), '')
    await discover.click()
    behavior = 'gate-key'
    await message.fill('更换 Key 时未完成的消息')
    await send.click()
    await page.waitForFunction(() => window.__playgroundGates['gate-key']?.ready)
    await keyInput.fill(key + '-final')
    assert.equal(await message.inputValue(), '')
    assert.equal(await panel.getByRole('button', { name: '取消调用', exact: true }).count(), 0)
    await page.evaluate(() => window.__playgroundGates['gate-key'].release())
    await page.waitForFunction(() => window.__playgroundGates['gate-key'].delivered)
    assert.equal(await panel.getByText('浏览器回复 7', { exact: true }).count(), 0)
    await discover.click()
    behavior = 'semantic'
    await message.fill('语义字段回复')
    await send.click()
    await panel.getByText('可见文本', { exact: true }).waitFor()
    await panel.getByText(/本调试器无法安全继续/).waitFor()
    assert.equal(await message.isDisabled(), true)
    assert.equal(await send.isDisabled(), true)
    assert.match(await panel.innerText(), /拒绝信息：（空）/)
    await clear.click()
    assert.equal(await message.isEnabled(), true)
    behavior = 'malformed'
    const beforeFailure = calls.length
    await message.fill('失败不能自动重发')
    await send.click()
    await panel.getByRole('alert').waitFor()
    assert.equal(calls.length, beforeFailure + 1)
    assert.equal(await message.inputValue(), '')
    assert.equal(await panel.getByText('PRIVATE_FIXTURE_DIAGNOSTIC', { exact: true }).count(), 0)
    behavior = 'normal'
    await message.fill('失败后明确新请求')
    await send.click()
    await panel.getByText('浏览器回复 10', { exact: true }).waitFor()
    assert.deepEqual(calls.filter((call) => call.operation === 'chat').at(-1).input.messages, [
      { role: 'user', content: '失败后明确新请求' },
    ])
    assert.equal(
      await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes('playground-fixture'),
      ),
      false,
      'no transient Key persistence',
    )
    await mkdir('.test-artifacts/playground-browser', { recursive: true })
    await page.screenshot({ path: '.test-artifacts/playground-browser/conversation.png', fullPage: true })
    assert.deepEqual(browserErrors, [], 'no uncaught browser errors')
    return {
      groups: 9,
      discoveryCalls: calls.filter((call) => call.operation === 'models').length,
      chatCalls: calls.filter((call) => call.operation === 'chat').length,
    }
  } finally {
    await page
      .evaluate(() => {
        if (window.__playgroundNativeFetch) window.fetch = window.__playgroundNativeFetch
        for (const gate of Object.values(window.__playgroundGates || {})) gate.release?.()
      })
      .catch(() => {})
    await page.unroute('**/api/projects?status=active')
    await page.unroute('**/api/playground/models')
    await page.unroute('**/api/playground/chat')
    page.off('pageerror', onError)
  }
}

export async function runPlaygroundBrowserE2E() {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {SessionProvider} from '@/components/SessionProvider'; import {RefreshProvider} from '@/components/RefreshProvider'; import {Playground} from '@/components/Playground'; createRoot(document.getElementById('root')).render(<React.StrictMode><SessionProvider><RefreshProvider><Playground/></RefreshProvider></SessionProvider></React.StrictMode>);`,
      resolveDir: process.cwd(),
      sourcefile: 'playground-browser.tsx',
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'harness-link-adapter',
        setup(builder) {
          builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'next/link', namespace: 'harness' }))
          builder.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({
            contents:
              "import React from 'react'; export default function Link({children,...props}){return <a {...props}>{children}</a>}",
            loader: 'jsx',
            resolveDir: process.cwd(),
          }))
        },
      },
    ],
  })
  const session = {
    authenticated: true,
    user: { id: 'browser-user', email: 'browser@example.invalid', name: 'Browser' },
    organization: { id: 'browser-org', tenantId: 'browser-tenant', name: 'Browser', slug: 'browser' },
    role: 'owner',
    capabilities: ['apikey:create', 'project:read'],
    freshAuth: true,
    sessionExpiresAt: '2030-01-01T00:00:00Z',
    environment: 'test',
  }
  const server = createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(bundle.outputFiles[0].text)
    } else if (req.url === '/api/auth/session') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'nexus_csrf=browser-fixture; Path=/' })
      res.end(JSON.stringify(session))
    } else {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } })
    page.setDefaultTimeout(15_000)
    const result = await playgroundE2E(page, origin, '/')
    await page.route('**/api/auth/session', (route) =>
      route.fulfill({ json: { ...session, role: 'viewer', capabilities: ['project:read'] } }),
    )
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByText('没有访问权限', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('调试项目 API Key').count(), 0)
    console.log(
      `PASS Playground browser ${result.groups + 1} groups; ${result.discoveryCalls} model calls / ${result.chatCalls} explicit fixture turns; no server authorization claim`,
    )
    return result
  } finally {
    await browser.close()
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runPlaygroundBrowserE2E()
