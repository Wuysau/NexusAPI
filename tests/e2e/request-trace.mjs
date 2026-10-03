import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

/** Native Next route → actual PostgreSQL facts → real dashboard browser. */
export async function requestTraceE2E(page, db, origin) {
  const prefix = `trace-e2e-${Date.now()}`
  await db.query("INSERT INTO projects(id,tenant_id,organization_id,name) VALUES($1,'tenant-dev','org-dev',$2)", [
    prefix,
    `Trace history ${prefix}`,
  ])
  await db.query(
    "INSERT INTO request_records(id,tenant_id,organization_id,request_model,channel_kind,status,error_message,started_at,completed_at) VALUES($1,'tenant-dev','org-dev','trace-browser-alias','byok','completed','trace-browser-content-canary',now()-interval '1 minute',now())",
    [prefix],
  )
  await db.query(
    "INSERT INTO request_project_facts(request_id,tenant_id,organization_id,project_id,project_name,execution_mode,attribution_status,catalog_version_id,policy_version_id) VALUES($1,'tenant-dev','org-dev',$1,$2,'unknown','attributed','browser-catalog','browser-policy')",
    [prefix, `Frozen Trace ${prefix}`],
  )
  for (const number of [1, 2])
    await db.query(
      "INSERT INTO attempts(id,tenant_id,request_id,attempt_number,status,upstream_request_id,error_message) VALUES($1,'tenant-dev',$2,$3,$4,$5,'trace-browser-content-canary')",
      [`${prefix}-${number}`, prefix, number, number === 1 ? 'failed' : 'completed', `provider-${number}`],
    )
  const event = {
    schema_version: 2,
    tenant_id: 'tenant-dev',
    request_id: prefix,
    usage: {
      input_tokens: 0,
      output_tokens: 2,
      cached_input_tokens: null,
      reasoning_tokens: null,
      total_tokens: 2,
      estimated: false,
    },
  }
  await db.query(
    "INSERT INTO usage_events(id,tenant_id,request_id,attempt_id,event_id,event_type,payload) VALUES($1,'tenant-dev',$2,$3,$1,'usage',$4)",
    [
      `${prefix}-event`,
      prefix,
      `${prefix}-2`,
      JSON.stringify({ event: { ...event, prompt: 'trace-browser-content-canary' } }),
    ],
  )
  const errors = []
  const onError = (error) => errors.push(error.message)
  page.on('pageerror', onError)
  try {
    const loaded = page.waitForResponse((response) => response.url().endsWith(`/api/logs/${prefix}/trace`))
    await page.goto(`${origin}/logs?requestId=${encodeURIComponent(prefix)}`, { waitUntil: 'networkidle' })
    const response = await loaded
    assert.equal(response.status(), 200)
    assert.equal(response.headers()['cache-control'], 'no-store')
    assert.equal(JSON.stringify(await response.json()).includes('trace-browser-content-canary'), false)
    const panel = page.getByRole('region', { name: '请求执行详情' })
    await panel.getByText(`Frozen Trace ${prefix}`, { exact: false }).waitFor()
    assert.match(await panel.innerText(), /尝试 #1/)
    assert.match(await panel.innerText(), /尝试 #2/)
    assert.match(await panel.innerText(), /输入：0/)
    assert.match(await panel.innerText(), /尚无结算依据/)
    assert.equal((await panel.innerText()).includes('trace-browser-content-canary'), false)
    await panel.getByRole('button', { name: '关闭请求详情' }).click()
    assert.equal(await panel.count(), 0)
    await page.getByPlaceholder('搜索模型、密钥或请求 ID...').fill(prefix)
    await page.getByRole('button', { name: `查看请求 ${prefix}`, exact: true }).click()
    await panel.getByText(`Frozen Trace ${prefix}`, { exact: false }).waitFor()
    await page.getByRole('combobox', { name: '按状态筛选' }).selectOption('error')
    assert.equal(await panel.count(), 0, 'filter replacement clears historical detail')
    assert.deepEqual(errors, [])
  } finally {
    page.off('pageerror', onError)
  }
}

function fixture(id, { label = id, count = 2, total = count } = {}) {
  const usage = {
    source: null,
    schemaVersion: null,
    usageEventId: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    estimated: null,
  }
  const timing = {
    startedAt: '2026-10-04T00:00:00.000Z',
    completedAt: null,
    durationMs: null,
    ttftMs: null,
    streamDurationMs: null,
  }
  const pins = { policyVersionId: 'policy-fixture', catalogVersionId: 'catalog-fixture', priceVersionId: null }
  return {
    version: 1,
    coverage: 'recorded_gateway_attempts',
    request: {
      id,
      traceId: `trace-${id}`,
      organizationId: 'fixture-org',
      project: { id: `project-${id}`, name: `DETAIL-${label}`, attributionStatus: 'attributed' },
      apiKeyId: 'fixture-key-id',
      requestedModel: `REQUEST-MODEL-${label}`,
      status: 'completed',
      errorCode: null,
      timing: { ...timing },
      pins: { ...pins },
      usage: { ...usage },
      settlement: null,
      taskId: null,
      sessionId: null,
    },
    attempts: Array.from({ length: count }, (_, index) => ({
      id: `${id}-${index}`,
      number: index + 1,
      status: index === 0 ? 'failed' : 'sent',
      providerId: 'fixture-provider',
      resolvedModel: `ACTUAL-${label}-${index + 1}`,
      channelId: `channel-${index}`,
      connectionId: null,
      executionMode: 'byok',
      providerRequestId: `provider-${index}`,
      errorCode: index === 0 ? 'provider_down' : null,
      timing: { ...timing },
      pins: { ...pins },
      usage: { ...usage },
      settlement: null,
    })),
    attemptCount: String(total),
    attemptLimit: 128,
    truncated: total > 128,
  }
}

/** Real React/LogTable/RequestTrace and Chromium; transport faults are fixtures. */
async function clientLifecycle() {
  const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import LogsPage from '@/app/(dashboard)/logs/page';
import {SessionProvider,useSession} from '@/components/SessionProvider';
import {RefreshProvider} from '@/components/RefreshProvider';
window.clientRequests=[]; window.jsonGates={}; window.detailCommits=[];
window.account='A';
const originalFetch=window.fetch.bind(window);
window.fetch=async (path, options)=>{
  // Give StrictMode's discarded setup its normal cleanup before transport.
  await Promise.resolve();
  if(options?.signal?.aborted) throw new DOMException('Cancelled','AbortError');
  window.clientRequests.push({path:String(path),method:options?.method??'GET'});
  const response=await originalFetch(path,options);
  const label=response.headers.get('x-fixture-json-gate');
  if(label){const read=response.json.bind(response); response.json=async()=>{
    const value=await read(); const gate={ready:true,delivered:false}; window.jsonGates[label]=gate;
    await new Promise(resolve=>gate.release=resolve); gate.delivered=true; return value;
  };} return response;
};
function Shell(){ const {refresh}=useSession(); return <>
  <button onClick={()=>{window.account=window.account==='A'?'B':'A';void refresh();}}>Switch account</button>
  <LogsPage/>
</>; }
new MutationObserver(()=>window.detailCommits.push(document.querySelector('[aria-label="请求执行详情"]')?.textContent??null)).observe(document.getElementById('root'),{subtree:true,childList:true,characterData:true});
createRoot(document.getElementById('root')).render(<React.StrictMode><SessionProvider><RefreshProvider><Shell/></RefreshProvider></SessionProvider></React.StrictMode>);
`
  const bundle = await build({
    stdin: { contents: entry, sourcefile: 'request-trace-harness.tsx', resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'navigation-only-adapter',
        setup(builder) {
          builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'harness' }))
          builder.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({
            loader: 'js',
            resolveDir: process.cwd(),
            contents: `import {useSyncExternalStore} from 'react';
        const subscribe=listener=>{window.addEventListener('popstate',listener);return()=>window.removeEventListener('popstate',listener);};
        export function useSearchParams(){return new URLSearchParams(useSyncExternalStore(subscribe,()=>location.search,()=>''));}
      `,
          }))
        },
      },
    ],
  })
  const plans = new Map()
  const responses = new Set()
  let requests = 0
  let unexpected = 0
  const browserErrors = []
  const failures = []
  let passed = 0
  let account = 'A'
  function deferred() {
    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    return { promise, resolve }
  }
  function plan(id, body, { status = 200, hold = false, gate } = {}) {
    const received = deferred()
    const queued = { body, status, hold, gate, received, release: null }
    const path = `/api/logs/${id}/trace`
    const queue = plans.get(path) ?? []
    queue.push(queued)
    plans.set(path, queue)
    return queued
  }
  function json(response, status, body, headers = {}) {
    response.writeHead(status, { 'content-type': 'application/json', ...headers })
    response.end(JSON.stringify(body))
  }
  const server = createServer((request, response) => {
    request.resume()
    if (request.url === '/bundle.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' })
      return response.end(bundle.outputFiles[0].contents)
    }
    if (request.url === '/api/auth/session')
      return json(response, 200, {
        authenticated: true,
        role: 'owner',
        capabilities: ['request:read'],
        user: { id: `user-${account}` },
        organization: { id: `org-${account}`, tenantId: `tenant-${account}` },
        environment: 'test',
      })
    if (request.url.startsWith('/api/logs?'))
      return json(response, 200, {
        total: '2',
        limit: 20,
        offset: 0,
        entries: ['A', 'B'].map((id) => ({
          id,
          model: `LIST-${id}`,
          upstreamModelId: null,
          providerCode: null,
          channelKind: 'byok',
          status: 'completed',
          inputTokens: null,
          outputTokens: null,
          charge: null,
          currency: 'USD',
          cost: null,
          errorCode: null,
          latencyMs: null,
          keyName: 'fixture-key',
          startedAt: '2026-10-04T00:00:00.000Z',
          completedAt: null,
        })),
      })
    if (/^\/api\/logs\/[^/]+\/trace$/.test(request.url)) {
      requests++
      const next = plans.get(request.url)?.shift()
      if (!next) {
        unexpected++
        return json(response, 500, { error: { code: 'unexpected', message: 'Unexpected detail fetch' } })
      }
      responses.add(response)
      response.on('close', () => responses.delete(response))
      next.release = () => json(response, next.status, next.body, next.gate ? { 'x-fixture-json-gate': next.gate } : {})
      next.received.resolve()
      if (!next.hold) next.release()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser
  let page
  const panel = () => page.getByRole('region', { name: '请求执行详情' })
  const select = (id) => page.getByRole('button', { name: `查看请求 ${id}`, exact: true }).click()
  const ready = (label) => panel().getByText(`DETAIL-${label}`, { exact: false }).waitFor()
  const drain = () =>
    page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  async function within(promise) {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('fixture request not received')), 5000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async function check(name, action, suffix = '') {
    plans.clear()
    account = 'A'
    page = await browser.newPage()
    page.setDefaultTimeout(5000)
    page.on('pageerror', (error) => browserErrors.push(error.message))
    try {
      await page.goto(origin + suffix)
      await page.getByRole('button', { name: '查看请求 A', exact: true }).waitFor()
      await action()
      passed++
      console.log('PASS ' + name)
    } catch (error) {
      failures.push(name)
      console.error('FAIL ' + name + ' — ' + error.message)
    } finally {
      await page.close()
      for (const response of responses) response.destroy()
      responses.clear()
    }
  }
  async function navigate(search) {
    await page.evaluate((search) => {
      history.pushState({}, '', search)
      dispatchEvent(new PopStateEvent('popstate'))
    }, search)
  }
  const errorBody = (message) => ({ error: { code: 'fixture_failure', message } })
  try {
    browser = await chromium.launch({ headless: true })
    await check('on-demand selection, ordered attempts, close and query clear', async () => {
      assert.equal(await panel().count(), 0)
      plan('A', fixture('A'))
      await select('A')
      await ready('A')
      assert.match(await panel().innerText(), /尝试 #1/)
      assert.match(await panel().innerText(), /尝试 #2/)
      assert.match(await panel().innerText(), /未知/)
      assert.match(await panel().innerText(), /尚无结算依据/)
      await panel().getByRole('button', { name: '关闭请求详情' }).click()
      assert.equal(await panel().count(), 0)
      plan('A', fixture('A'))
      await select('A')
      await ready('A')
      await page.getByPlaceholder('搜索模型、密钥或请求 ID...').fill('B')
      assert.equal(await panel().count(), 0)
    })
    await check('explicit /logs?requestId links select even outside the current log page', async () => {
      plan('linked', fixture('linked'))
      await navigate('/logs?requestId=linked')
      await ready('linked')
      assert.equal(await page.getByRole('button', { name: '查看请求 linked', exact: true }).count(), 0)
      await navigate('/logs?requestId=bad%20id')
      assert.equal(await panel().count(), 0)
    })
    await check('A detail disappears before pending/failed B and a manual retry recovers', async () => {
      plan('A', fixture('A'))
      await select('A')
      await ready('A')
      const b = plan('B', errorBody('B unavailable'), { status: 503, hold: true })
      await select('B')
      await within(b.received.promise)
      assert.equal(await page.getByText(/DETAIL-A/).count(), 0)
      await panel().getByText('读取已记录的请求…', { exact: true }).waitFor()
      b.release()
      await panel().getByRole('alert').filter({ hasText: 'B unavailable' }).waitFor()
      assert.equal(await page.getByText(/DETAIL-A/).count(), 0)
      plan('B', fixture('B'))
      await panel().getByRole('button', { name: '重试', exact: true }).click()
      await ready('B')
    })
    for (const status of [200, 503])
      await check(`A→B→A ignores obsolete ${status} body delivery and its finally`, async () => {
        plan('A', status === 200 ? fixture('A', { label: 'obsolete-A' }) : errorBody('obsolete-A-error'), {
          status,
          gate: 'old-A',
        })
        await select('A')
        await page.waitForFunction(() => window.jsonGates['old-A']?.ready)
        plan('B', fixture('B'))
        await select('B')
        await ready('B')
        const current = plan('A', fixture('A', { label: 'current-A' }), { hold: true })
        await select('A')
        await within(current.received.promise)
        await page.evaluate(() => window.jsonGates['old-A'].release())
        await page.waitForFunction(() => window.jsonGates['old-A'].delivered)
        await drain()
        assert.equal(await page.getByText(/obsolete-A|DETAIL-B/).count(), 0)
        await panel().getByText('读取已记录的请求…', { exact: true }).waitFor()
        current.release()
        await ready('current-A')
      })
    await check('closing a pending detail cancels ownership and performs no replay', async () => {
      plan('A', fixture('A', { label: 'closed-A' }), { gate: 'closing-A' })
      await select('A')
      await page.waitForFunction(() => window.jsonGates['closing-A']?.ready)
      const before = requests
      await panel().getByRole('button', { name: '关闭请求详情' }).click()
      await page.evaluate(() => window.jsonGates['closing-A'].release())
      await page.waitForFunction(() => window.jsonGates['closing-A'].delivered)
      await drain()
      assert.equal(await panel().count(), 0)
      assert.equal(await page.getByText(/DETAIL-closed-A/).count(), 0)
      assert.equal(requests, before)
    })
    await check('account switch unmounts old scope before a late body can show', async () => {
      plan('A', fixture('A', { label: 'old-account' }), { gate: 'account-A' })
      await select('A')
      await page.waitForFunction(() => window.jsonGates['account-A']?.ready)
      account = 'B'
      await page.getByRole('button', { name: 'Switch account', exact: true }).click()
      await drain()
      assert.equal(await panel().count(), 0)
      await page.evaluate(() => window.jsonGates['account-A'].release())
      await page.waitForFunction(() => window.jsonGates['account-A'].delivered)
      await drain()
      assert.equal(await page.getByText(/old-account/).count(), 0)
      plan('B', fixture('B', { label: 'new-account' }))
      await select('B')
      await ready('new-account')
    })
    await check('malformed/mismatched successful detail is rejected without unsafe rendering', async () => {
      plan('A', { ...fixture('B'), payload: 'CONTENT-CANARY' })
      await select('A')
      await panel().getByRole('alert').filter({ hasText: '请求详情响应无效' }).waitFor()
      assert.equal(await page.getByText(/CONTENT-CANARY|DETAIL-B/).count(), 0)
    })
    await check('mobile bounded timeline explicitly declares truncation', async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      plan('A', fixture('A', { count: 128, total: 129 }))
      await select('A')
      await ready('A')
      assert.match(await panel().getByRole('status').innerText(), /129.*128.*不完整/)
      assert.equal(await panel().getByRole('listitem').count(), 128)
    })
    assert.deepEqual(browserErrors, [], 'no browser runtime errors')
    assert.equal(unexpected, 0, 'no unexpected detail retries or model calls')
    console.log(`${passed} passed; ${failures.length} failed; React/Chromium client fixtures only`)
    if (failures.length) process.exitCode = 1
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await clientLifecycle()
