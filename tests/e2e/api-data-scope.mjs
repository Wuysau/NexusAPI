// Real React, useApiData, both providers, RoutingPage, Chromium and loopback HTTP.
// This is a client lifecycle harness, not a Next/server authorization test.
// Run: node tests/e2e/api-data-scope.mjs
// Optional regression overlay: API_DATA_TEST_HOOK_SOURCE points to an old hook;
// its relative imports still resolve against the production hook's directory.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const hookFile = resolve('src/components/lib/useApiData.ts')
const entry = `
import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useApiData} from '@/components/lib/useApiData';
import {RefreshProvider, useRefresh} from '@/components/RefreshProvider';
import {SessionProvider, useSession} from '@/components/SessionProvider';
import RoutingPage from '@/app/(dashboard)/routing/page';
window.commits = [];
window.effectCommit = 0;
window.clientRequests = [];
window.jsonGates = {};
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  window.clientRequests.push(String(args[0]));
  const response = await nativeFetch(...args);
  const label = response.headers.get('x-fixture-json-gate');
  if (label) {
    const readJSON = response.json.bind(response);
    response.json = async () => {
      const body = await readJSON();
      const gate = {ready: true, delivered: false};
      window.jsonGates[label] = gate;
      // The body is already read. Deliberately ignore abort only while delaying
      // promise delivery, so obsolete success/error/finally paths are exercised.
      await new Promise(resolve => gate.release = resolve);
      gate.delivered = true;
      return body;
    };
  }
  return response;
};
function Probe() {
  const [path, setPath] = useState(null);
  const state = useApiData(path);
  const {refresh} = useRefresh();
  const {state: session} = useSession();
  const firstReload = useRef(state.reload);
  const snapshot = {path, data: state.data, loading: state.loading, error: state.error,
    forbidden: state.forbidden, loadedAt: state.loadedAt};
  useLayoutEffect(() => {
    window.commits.push({...snapshot, reloadStable: firstReload.current === state.reload});
    window.probeState = snapshot;
    window.sessionStatus = session.status;
  });
  useEffect(() => { window.effectCommit = window.commits.length; });
  return <main>
    <button onClick={() => setPath('/probe/a')}>A</button>
    <button onClick={() => setPath('/probe/b')}>B</button>
    <button onClick={() => setPath(null)}>Disable</button>
    <button onClick={state.reload}>Local refresh</button>
    <button onClick={refresh}>Global refresh</button>
    <pre>{JSON.stringify(snapshot)}</pre>
  </main>;
}
createRoot(document.getElementById('root')).render(
  <React.StrictMode><SessionProvider><RefreshProvider>
    {location.search.includes('routing') ? <RoutingPage/> : <Probe/>}
  </RefreshProvider></SessionProvider></React.StrictMode>
);
`

const bundle = await build({
  stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'api-data-scope-harness.tsx', loader: 'tsx' },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'harness-only-adapters',
      setup(builder) {
        if (process.env.API_DATA_TEST_HOOK_SOURCE) {
          builder.onResolve({ filter: /useApiData$/ }, () => ({ path: hookFile, namespace: 'old-hook' }))
          builder.onLoad({ filter: /.*/, namespace: 'old-hook' }, async () => ({
            contents: await readFile(process.env.API_DATA_TEST_HOOK_SOURCE, 'utf8'),
            loader: 'ts',
            resolveDir: dirname(hookFile),
          }))
        }
        // RoutingPage keeps its real UI/selection logic. Navigation and CSS need
        // no Next runtime for this state-isolation test.
        builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'view-adapter' }))
        builder.onResolve({ filter: /\.css$/ }, () => ({ path: 'style', namespace: 'view-adapter' }))
        builder.onLoad({ filter: /.*/, namespace: 'view-adapter' }, ({ path }) => ({
          contents:
            path === 'link' ? 'export default function Link({children}) { return children; }' : 'export default {};',
          loader: 'js',
        }))
      },
    },
  ],
})

const plans = new Map()
const responses = new Set()
const browserErrors = []
const failures = []
let unexpected = 0
let passed = 0
function deferred() {
  let resolve
  const promise = new Promise((done) => (resolve = done))
  return { promise, resolve }
}
function plan(path, body, { status = 200, hold = false, gate } = {}) {
  const received = deferred()
  const pending = { received: received.promise, release: undefined }
  const queue = plans.get(path) ?? []
  queue.push({ body, status, hold, gate, pending, received })
  plans.set(path, queue)
  return pending
}
const errorBody = (message) => ({ error: { code: 'fixture_error', message } })
const policy = (name) => ({
  resources: [],
  policy: {
    name,
    workload: 'fixture',
    requiredCapabilities: [],
    tool: 'codex',
    model: null,
    autoFailover: false,
    autoReturn: false,
    candidates: [],
  },
})
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
  if (request.url === '/api/auth/session' && !plans.get(request.url)?.length)
    return json(response, 200, {
      authenticated: true,
      role: 'owner',
      capabilities: ['project:read', 'credential:read'],
      user: { id: 'fixture-user' },
      organization: { id: 'fixture-org', tenantId: 'fixture-tenant' },
      environment: 'test',
    })
  if (request.url === '/api/projects')
    return json(response, 200, {
      projects: [
        { id: 'A', name: 'Project A' },
        { id: 'B', name: 'Project B' },
      ],
    })
  if (request.url === '/api/resources') return json(response, 200, { resources: [] })
  if (request.url.startsWith('/probe/') || request.url.startsWith('/api/task-runtime') || plans.has(request.url)) {
    const next = plans.get(request.url)?.shift()
    if (!next) {
      unexpected++
      return json(response, 500, errorBody('unexpected fixture request'))
    }
    responses.add(response)
    response.on('close', () => responses.delete(response))
    next.pending.release = () =>
      json(response, next.status, next.body, next.gate ? { 'x-fixture-json-gate': next.gate } : {})
    next.received.resolve()
    if (!next.hold) next.pending.release()
    return
  }
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>')
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = 'http://127.0.0.1:' + server.address().port
let browser
let page

async function within(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('fixture request did not arrive')), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function check(name, action) {
  plans.clear()
  page = await browser.newPage()
  page.setDefaultTimeout(5000)
  page.on('pageerror', (error) => browserErrors.push(error.message))
  try {
    await page.goto(origin)
    await page.waitForFunction(() => window.effectCommit > 0)
    await action()
    assert.equal(
      await page.evaluate(() => window.commits.every((state) => state.reloadStable)),
      true,
      'reload identity stays stable',
    )
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
const click = (name) => page.getByRole('button', { name, exact: true }).click()
const snapshot = () => page.evaluate(() => window.probeState)
const waitState = (expected) =>
  page.waitForFunction(
    (expected) =>
      Object.entries(expected).every(
        ([key, value]) => JSON.stringify(window.probeState?.[key]) === JSON.stringify(value),
      ),
    expected,
  )
async function readA(value = 'A-original') {
  plan('/probe/a', { value })
  await click('A')
  await waitState({ data: { value }, loading: false })
  return snapshot()
}
function assertEmpty(state, loading) {
  assert.equal(state.data, null)
  assert.equal(state.loadedAt, null)
  assert.equal(state.error, null)
  assert.equal(state.forbidden, false)
  assert.equal(state.loading, loading)
}
async function assertNewCommits(path, from, loading) {
  const committed = await page.evaluate(
    ({ path, from }) => window.commits.slice(from).filter((state) => state.path === path),
    { path, from },
  )
  assert.ok(committed.length > 0, 'new path committed')
  for (const state of committed) assertEmpty(state, loading)
}

try {
  browser = await chromium.launch({ headless: true })
  await check('new path clears A before the first B commit, including pending and 503', async () => {
    await readA()
    const from = await page.evaluate(() => window.commits.length)
    const b = plan('/probe/b', errorBody('B unavailable'), { hold: true, status: 503 })
    await click('B')
    await within(b.received)
    await assertNewCommits('/probe/b', from, true)
    b.release()
    await waitState({ error: 'B unavailable', loading: false })
    const state = await snapshot()
    assert.equal(state.data, null)
    assert.equal(state.loadedAt, null)
  })

  await check('null clears data, timestamp, error and forbidden; refresh causes no traffic', async () => {
    await readA()
    plan('/probe/a', errorBody('A denied'), { status: 403 })
    await click('Local refresh')
    await waitState({ error: 'A denied', forbidden: true, loading: false })
    const before = await page.evaluate(() => ({
      commits: window.commits.length,
      requests: window.clientRequests.length,
    }))
    await click('Disable')
    await page.waitForFunction((count) => window.effectCommit > count, before.commits)
    await assertNewCommits(null, before.commits, false)
    for (const label of ['Local refresh', 'Global refresh']) {
      const count = await page.evaluate(() => window.commits.length)
      await click(label)
      await page.waitForFunction((count) => window.effectCommit > count, count)
      assertEmpty(await snapshot(), false)
    }
    assert.equal(await page.evaluate(() => window.clientRequests.length), before.requests)
  })

  for (const label of ['Local refresh', 'Global refresh']) {
    await check(`same-path ${label} retains last-good data/time through failure and recovers`, async () => {
      const original = await readA()
      const refresh = plan('/probe/a', errorBody('refresh unavailable'), { hold: true, status: 503 })
      await click(label)
      await within(refresh.received)
      assert.deepEqual((await snapshot()).data, original.data)
      assert.equal((await snapshot()).loadedAt, original.loadedAt)
      refresh.release()
      await waitState({ error: 'refresh unavailable', loading: false })
      assert.deepEqual((await snapshot()).data, original.data)
      assert.equal((await snapshot()).loadedAt, original.loadedAt)
      plan('/probe/a', { value: 'A-recovered' })
      await click(label)
      await waitState({ data: { value: 'A-recovered' }, error: null, forbidden: false, loading: false })
      assert.equal(typeof (await snapshot()).loadedAt, 'number')
    })
  }

  for (const status of [200, 503]) {
    await check(`A→B→A ignores obsolete ${status} promise delivery and its finally`, async () => {
      plan('/probe/a', status === 200 ? { value: 'obsolete-A' } : errorBody('obsolete-A-error'), {
        status,
        gate: 'old-A',
      })
      await click('A')
      await page.waitForFunction(() => window.jsonGates['old-A']?.ready)
      plan('/probe/b', { value: 'B-current' })
      await click('B')
      await waitState({ data: { value: 'B-current' }, loading: false })
      const current = plan('/probe/a', { value: 'new-A' }, { hold: true })
      const from = await page.evaluate(() => window.commits.length)
      await click('A')
      await within(current.received)
      await assertNewCommits('/probe/a', from, true)
      await page.evaluate(() => window.jsonGates['old-A'].release())
      await page.waitForFunction(() => window.jsonGates['old-A'].delivered)
      // Drain promise continuations and React's render work before checking that
      // obsolete finally did not turn off the current request's loading state.
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
      assertEmpty(await snapshot(), true)
      current.release()
      await waitState({ data: { value: 'new-A' }, error: null, forbidden: false, loading: false })
    })
  }

  await check('valid JSON null is a successful last-good value, tracked by loadedAt', async () => {
    plan('/probe/a', null)
    await click('A')
    await page.waitForFunction(() => window.probeState.loadedAt !== null && !window.probeState.loading)
    const original = await snapshot()
    assert.equal(original.data, null)
    const refresh = plan('/probe/a', errorBody('null refresh unavailable'), { status: 503, hold: true })
    await click('Local refresh')
    await within(refresh.received)
    assert.equal((await snapshot()).loading, false)
    assert.equal((await snapshot()).loadedAt, original.loadedAt)
    refresh.release()
    await waitState({ data: null, error: 'null refresh unavailable', loading: false })
    assert.equal((await snapshot()).loadedAt, original.loadedAt)
  })

  await check('obsolete 401 session refresh cannot finish a newer path loading state', async () => {
    await readA()
    plan('/probe/a', errorBody('reauthentication required'), { status: 401 })
    const session = plan('/api/auth/session', { authenticated: false }, { hold: true })
    await click('Local refresh')
    await within(session.received)
    const b = plan('/probe/b', { value: 'B-after-session-refresh' }, { hold: true })
    await click('B')
    await within(b.received)
    assertEmpty(await snapshot(), true)
    session.release()
    await page.waitForFunction(() => window.sessionStatus === 'anonymous')
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    assertEmpty(await snapshot(), true)
    b.release()
    await waitState({ data: { value: 'B-after-session-refresh' }, error: null, loading: false })
  })

  await check('actual RoutingPage shows no A policy while B is pending or failed', async () => {
    plan('/api/task-runtime?projectId=A', policy('PROJECT-A-POLICY'))
    const b = plan('/api/task-runtime?projectId=B', errorBody('B runtime unavailable'), { status: 503, hold: true })
    await page.goto(origin + '/?routing')
    await page.getByText(/PROJECT-A-POLICY/).waitFor()
    await page.getByRole('combobox', { name: '项目' }).selectOption('B')
    await within(b.received)
    assert.equal(await page.getByText(/PROJECT-A-POLICY/).count(), 0)
    assert.equal(await page.getByText('读取任务候选…', { exact: true }).count(), 1)
    b.release()
    await page.getByRole('alert').filter({ hasText: 'B runtime unavailable' }).waitFor()
    assert.equal(await page.getByText(/PROJECT-A-POLICY/).count(), 0)
    plan('/api/task-runtime?projectId=B', policy('PROJECT-B-POLICY'))
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await page.getByText(/PROJECT-B-POLICY/).waitFor()
    assert.equal(await page.getByText(/PROJECT-A-POLICY/).count(), 0)
  })
  assert.deepEqual(browserErrors, [], 'no uncaught browser errors')
  assert.equal(unexpected, 0, 'no unexpected or replayed API calls')
  console.log(`${passed} passed; ${failures.length} failed; hook/page client scope only`)
  if (failures.length) process.exitCode = 1
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}
