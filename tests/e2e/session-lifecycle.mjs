// Client-only lifecycle regression: real Dashboard, Topbar, LoginScreen,
// ReauthDialog, SessionProvider, browser fetch and controlled loopback HTTP.
// No Next server, database, credential service or server Set-Cookie race is tested.
// Run: node tests/e2e/session-lifecycle.mjs
// SESSION_TEST_PROVIDER_SOURCE optionally loads an old provider for RED evidence.
// SESSION_TEST_CORE_ONLY=1 runs only the three real Dashboard races.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const obsoleteMessage = '登录状态已改变，请重新操作。'
const privateMarker = 'synthetic-private-session-marker'
const providerFile = resolve('src/components/SessionProvider.tsx')
const entry = `
import React, {useLayoutEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import DashboardLayout from '@/app/(dashboard)/layout';
import {SessionProvider, useSession} from '@/components/SessionProvider';
import {ToastProvider} from '@/components/Toast';
import {ReauthDialog} from '@/components/ReauthDialog';
import {useHighRiskAction} from '@/components/lib/useHighRiskAction';
import {ApiError} from '@/components/lib/api';
window.requests = []; window.gates = {}; window.outcomes = {}; window.commits = [];
window.actionCalls = 0; window.reauthSuccess = 0;
window.hostLifecycle = {setups:0,cleanups:0};
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const signal = args[1]?.signal;
  const record = {path:String(args[0]),method:args[1]?.method ?? 'GET',signal:!!signal,aborted:signal?.aborted ?? false};
  window.requests.push(record);
  signal?.addEventListener('abort', () => record.aborted = true, {once:true});
  const response = await nativeFetch(...args);
  const readJSON = response.json.bind(response);
  const label = response.headers.get('x-json-gate');
  response.json = async () => {
    record.reading = true;
    const body = await readJSON();
    if (label) {
      const gate = {ready:true, delivered:false}; window.gates[label] = gate;
      // Native fetch/body reading already completed. Only this test promise
      // ignores abort, proving the provider's ownership checks independently.
      await new Promise(resolve => gate.release = resolve);
      gate.delivered = true;
    }
    return body;
  };
  return response;
};
window.run = (label, action, ...args) => {
  window.outcomes[label] = {pending:true};
  Promise.resolve().then(() => window.ops[action](...args)).then(
    () => window.outcomes[label] = {ok:true},
    error => window.outcomes[label] = {ok:false,name:error.name,code:error.code,status:error.status,message:error.message}
  );
};
function Probe() {
  const context = useSession();
  const risk = useHighRiskAction();
  const snapshot = {status:context.state.status,user:context.session?.user.id,
    freshAuth:context.session?.freshAuth,canManage:context.can('member:write'),
    error:context.state.status === 'anonymous' ? context.state.error : undefined};
  useLayoutEffect(() => {
    window.ops = context; window.snapshot = snapshot; window.commits.push(snapshot);
  });
  const highRiskAction = async () => {
    window.actionCalls++;
    if (window.actionCalls === 1) throw new ApiError(401, 'forbidden', 'fixture reauthentication required');
  };
  return <>
    <pre id="session-state">{JSON.stringify(snapshot)}</pre>
    <button onClick={() => void risk.run(highRiskAction)}>High-risk fixture</button>
    {risk.needsReauth && <ReauthDialog onClose={risk.clear} onSuccess={() => {
      window.reauthSuccess++;
      void risk.retry();
    }}/>} 
  </>;
}
function Host() {
  const [mounted,setMounted] = useState(true);
  useLayoutEffect(() => {window.unmountProvider = () => setMounted(false);});
  useLayoutEffect(() => {
    window.hostLifecycle.setups++;
    return () => {window.hostLifecycle.cleanups++;};
  }, []);
  if (!mounted) return <p>Fixture unmounted</p>;
  return location.search.includes('dashboard') ? <DashboardLayout><Probe/></DashboardLayout> :
    <SessionProvider><ToastProvider><Probe/></ToastProvider></SessionProvider>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Host/></React.StrictMode>);
`
const bundle = await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'tsx', sourcefile: 'session-lifecycle-harness.tsx' },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'client-harness-adapters',
      setup(builder) {
        if (process.env.SESSION_TEST_PROVIDER_SOURCE) {
          builder.onResolve({ filter: /SessionProvider$/ }, () => ({ path: providerFile, namespace: 'old-provider' }))
          builder.onLoad({ filter: /.*/, namespace: 'old-provider' }, async () => ({
            contents: await readFile(process.env.SESSION_TEST_PROVIDER_SOURCE, 'utf8'),
            resolveDir: dirname(providerFile),
            loader: 'tsx',
          }))
        }
        builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'view-adapter' }))
        builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'view-adapter' }))
        builder.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'view-adapter' }))
        builder.onLoad({ filter: /.*/, namespace: 'view-adapter' }, ({ path }) => ({
          loader: 'js',
          contents:
            path === 'navigation'
              ? "const router={push(){},replace(){},refresh(){}};export const useRouter=()=>router;export const usePathname=()=>'/';"
              : path === 'link'
                ? 'export default function Link({children}) {return children;}'
                : 'export default {};',
        }))
      },
    },
  ],
})

function session(user, freshAuth = false) {
  return {
    authenticated: true,
    user: { id: user, email: user + '@fixture.invalid', name: user },
    organization: { id: 'org-' + user, tenantId: 'tenant-' + user, name: 'Organization ' + user, slug: user },
    role: user === 'A' ? 'owner' : 'viewer',
    capabilities: user === 'A' ? ['member:write'] : [],
    freshAuth,
    sessionExpiresAt: '2100-01-01T00:00:00Z',
    environment: 'test',
  }
}
const plans = new Map()
const activeResponses = new Set()
const browserErrors = []
const failures = []
let remote,
  browser,
  page,
  passed = 0
function deferred() {
  let resolve
  const promise = new Promise((done) => (resolve = done))
  return { promise, resolve }
}
function plan(method, path, body, { status = 200, hold = false, gate, raw = false } = {}) {
  const received = deferred(),
    closed = deferred()
  const pending = { received: received.promise, closed: closed.promise, release: undefined }
  const key = method + ' /api/auth/' + path
  const queue = plans.get(key) ?? []
  queue.push({ body, status, hold, gate, raw, received, closed, pending })
  plans.set(key, queue)
  return pending
}
const errorBody = (message, code = 'fixture_error') => ({ error: { code, message } })
const server = createServer((request, response) => {
  request.resume()
  if (request.url === '/bundle.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' })
    return response.end(bundle.outputFiles[0].contents)
  }
  if (request.url.startsWith('/api/auth/')) {
    if (request.method === 'POST') {
      if (request.url.endsWith('/logout')) remote = { authenticated: false, environment: 'test' }
      if (request.url.endsWith('/login')) remote = session('B', true)
      if (request.url.endsWith('/reauth')) remote = session(remote.user?.id ?? 'A', true)
    }
    const next = plans.get(request.method + ' ' + request.url)?.shift()
    const body = next ? next.body : request.method === 'GET' ? structuredClone(remote) : { ok: true }
    activeResponses.add(response)
    response.on('close', () => {
      activeResponses.delete(response)
      next?.closed.resolve(!response.writableFinished)
    })
    response.writeHead(next?.status ?? 200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(next?.gate ? { 'x-json-gate': next.gate } : {}),
    })
    const release = () => response.end(next?.raw ? body : JSON.stringify(body))
    if (next) {
      next.pending.release = release
      next.received.resolve()
    }
    if (next?.hold) {
      response.write(' ')
      response.flushHeaders()
    } else release()
    return
  }
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>')
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = 'http://127.0.0.1:' + server.address().port

async function within(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('fixture did not settle')), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function check(name, action, dashboard = false) {
  if (process.env.SESSION_TEST_CORE_ONLY === '1' && !dashboard) return
  plans.clear()
  remote = session('A')
  page = await browser.newPage()
  page.setDefaultTimeout(5000)
  page.on('pageerror', (error) => browserErrors.push(error.message))
  try {
    await page.goto(origin + (dashboard ? '/?dashboard' : '/'))
    await waitState({ user: 'A', status: 'authenticated' })
    await action()
    passed++
    console.log('PASS ' + name)
  } catch (error) {
    failures.push(name)
    console.error('FAIL ' + name + ' — ' + error.message)
  } finally {
    await page.close()
    for (const response of activeResponses) response.destroy()
    activeResponses.clear()
  }
}
const waitState = (expected) =>
  page.waitForFunction((expected) => {
    const text = document.querySelector('#session-state')?.textContent
    const current = text ? JSON.parse(text) : { status: 'anonymous' }
    return Object.entries(expected).every(([key, value]) => current[key] === value)
  }, expected)
const snapshot = () =>
  page.evaluate(() => {
    const text = document.querySelector('#session-state')?.textContent
    return text ? JSON.parse(text) : { status: 'anonymous' }
  })
const run = (label, action, ...args) =>
  page.evaluate(({ label, action, args }) => window.run(label, action, ...args), { label, action, args })
async function outcome(label) {
  await page.waitForFunction((label) => !window.outcomes[label]?.pending && !!window.outcomes[label], label)
  return page.evaluate((label) => window.outcomes[label], label)
}
const countReads = () => page.evaluate(() => window.requests.filter((request) => request.method === 'GET').length)
const paint = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
async function releaseGate(label) {
  await page.evaluate((label) => window.gates[label].release(), label)
  await page.waitForFunction((label) => window.gates[label]?.delivered, label)
  await paint()
}
async function gatedRefresh(label, body = session('A'), status = 200, ui = false) {
  plan('GET', 'session', body, { gate: label, status })
  if (ui) await page.getByRole('button', { name: '刷新数据', exact: true }).click()
  else await run(label, 'refresh')
  await page.waitForFunction((label) => window.gates[label]?.ready, label)
}
async function uiLogout() {
  await page.getByRole('button', { name: '账户菜单', exact: true }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('heading', { name: '登录控制台', exact: true }).waitFor()
}
async function uiReauth() {
  await page.getByRole('button', { name: '账户菜单', exact: true }).click()
  await page.getByRole('button', { name: '重新验证身份', exact: true }).click()
  await page.getByLabel('登录密码', { exact: true }).fill('synthetic-password')
  await page.getByRole('button', { name: '验证', exact: true }).click()
}
function assertObsolete(result) {
  assert.equal(result.ok, false)
  assert.equal(result.name, 'AbortError')
  assert.equal(result.message, obsoleteMessage)
  assert.equal(result.message.includes(privateMarker), false)
}

try {
  browser = await chromium.launch({ headless: true })
  await check(
    'Dashboard remains logged out after an old session promise completes',
    async () => {
      await gatedRefresh('old-logout', session('A'), 200, true)
      await uiLogout()
      await releaseGate('old-logout')
      assert.equal((await snapshot()).status, 'anonymous')
      assert.equal(await page.getByRole('heading', { name: '登录控制台', exact: true }).count(), 1)
    },
    true,
  )
  await check(
    'LoginScreen login B cannot be overwritten by an old A response',
    async () => {
      await gatedRefresh('old-login', session('A'), 200, true)
      await uiLogout()
      await page.getByLabel('邮箱', { exact: true }).fill('B@fixture.invalid')
      await page.getByLabel('密码', { exact: true }).fill('synthetic-password')
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await waitState({ user: 'B', canManage: false })
      await releaseGate('old-login')
      assert.equal((await snapshot()).user, 'B')
      assert.equal((await snapshot()).canManage, false)
    },
    true,
  )
  await check(
    'Topbar reauthentication keeps freshAuth after an older read completes',
    async () => {
      await gatedRefresh('old-reauth', session('A', false), 200, true)
      await uiReauth()
      await waitState({ user: 'A', freshAuth: true })
      await releaseGate('old-reauth')
      assert.equal((await snapshot()).freshAuth, true)
    },
    true,
  )

  await check('newer GET aborts the older native body read and owns the result', async () => {
    const old = plan('GET', 'session', session('A'), { hold: true })
    await run('native-old', 'refresh')
    await within(old.received)
    await page.waitForFunction(() => window.requests.at(-1)?.reading)
    plan('GET', 'session', session('B'))
    await run('native-new', 'refresh')
    await outcome('native-new')
    assert.equal(await within(old.closed), true, 'obsolete read closes its real HTTP body')
    assert.equal((await snapshot()).user, 'B')
  })
  await check('obsolete GET failure cannot log out a newer successful identity', async () => {
    await gatedRefresh('old-failure', errorBody(privateMarker), 503)
    plan('GET', 'session', session('B'))
    await run('new-success', 'refresh')
    await outcome('new-success')
    await releaseGate('old-failure')
    assert.equal((await snapshot()).user, 'B')
    assert.equal((await snapshot()).error, undefined)
  })
  await check('pending login blocks refresh; obsolete login completion starts no GET', async () => {
    plan('POST', 'login', { ok: true }, { gate: 'old-post-login' })
    await run('login-old', 'login', 'B@fixture.invalid', 'synthetic-password')
    await page.waitForFunction(() => window.gates['old-post-login']?.ready)
    const before = await countReads()
    await run('blocked-refresh', 'refresh')
    await outcome('blocked-refresh')
    assert.equal(await countReads(), before)
    await run('logout-current', 'logout')
    await outcome('logout-current')
    await releaseGate('old-post-login')
    assertObsolete(await outcome('login-old'))
    assert.equal(await countReads(), before)
    assert.equal((await snapshot()).status, 'anonymous')
  })
  await check('obsolete POST failure cannot clear the newer mutation barrier', async () => {
    plan('POST', 'reauth', errorBody(privateMarker), { status: 403, gate: 'old-post-error' })
    await run('reauth-old', 'reauth', 'synthetic-password')
    await page.waitForFunction(() => window.gates['old-post-error']?.ready)
    const login = plan('POST', 'login', { ok: true }, { hold: true })
    await run('login-current', 'login', 'B@fixture.invalid', 'synthetic-password')
    await within(login.received)
    await releaseGate('old-post-error')
    assertObsolete(await outcome('reauth-old'))
    const before = await countReads()
    await run('during-new-login', 'refresh')
    await outcome('during-new-login')
    assert.equal(await countReads(), before)
    login.release()
    assert.equal((await outcome('login-current')).ok, true)
    await waitState({ user: 'B' })
  })
  await check('obsolete ReauthDialog completion cannot call onSuccess or high-risk retry', async () => {
    await page.getByRole('button', { name: 'High-risk fixture', exact: true }).click()
    plan('POST', 'reauth', { ok: true }, { gate: 'old-dialog-post' })
    await page.getByLabel('登录密码', { exact: true }).fill('synthetic-password')
    await page.getByRole('button', { name: '验证', exact: true }).click()
    await page.waitForFunction(() => window.gates['old-dialog-post']?.ready)
    await run('invalidate-dialog', 'logout')
    await outcome('invalidate-dialog')
    const before = await countReads()
    await releaseGate('old-dialog-post')
    await page.getByRole('alert').filter({ hasText: obsoleteMessage }).waitFor()
    assert.equal(await page.evaluate(() => window.reauthSuccess), 0)
    assert.equal(await page.evaluate(() => window.actionCalls), 1)
    assert.equal(await countReads(), before)
  })
  await check('unmount closes native session reads and performs no later state commit', async () => {
    const held = plan('GET', 'session', session('B'), { hold: true })
    await run('unmount-read', 'refresh')
    await within(held.received)
    await page.waitForFunction(() => window.requests.at(-1)?.reading)
    const commits = await page.evaluate(() => window.commits.length)
    await page.evaluate(() => window.unmountProvider())
    assert.equal(await within(held.closed), true)
    await outcome('unmount-read')
    await paint()
    assert.equal(await page.evaluate(() => window.commits.length), commits)
  })
  await check('unmount rejects a pending auth completion without another read or POST', async () => {
    plan('POST', 'login', { ok: true }, { gate: 'unmounted-login' })
    await run('unmounted-login', 'login', 'B@fixture.invalid', 'synthetic-password')
    await page.waitForFunction(() => window.gates['unmounted-login']?.ready)
    const before = await countReads()
    await page.evaluate(() => window.unmountProvider())
    await releaseGate('unmounted-login')
    assertObsolete(await outcome('unmounted-login'))
    assert.equal(await countReads(), before)
    assert.equal(await page.evaluate(() => window.requests.filter((request) => request.method === 'POST').length), 1)
  })
  await check('StrictMode starts only the surviving initial read and allows later refresh', async () => {
    assert.deepEqual(await page.evaluate(() => window.hostLifecycle), { setups: 2, cleanups: 1 })
    const initial = await page.evaluate(() => window.requests.filter((request) => request.method === 'GET'))
    assert.equal(initial.length, 1)
    assert.equal(initial[0].signal, true)
    assert.equal(initial[0].aborted, false)
    assert.equal((await snapshot()).user, 'A')
    plan('GET', 'session', session('B'))
    await run('after-initial-cleanup', 'refresh')
    await outcome('after-initial-cleanup')
    await waitState({ user: 'B', status: 'authenticated' })
    assert.equal(await countReads(), 2)
  })
  await check('explicit session error cancels in-flight reads and remains anonymous', async () => {
    const held = plan('GET', 'session', session('A'), { hold: true })
    await run('before-error', 'refresh')
    await within(held.received)
    await page.evaluate(() => window.ops.error('fixed caller error'))
    assert.equal(await within(held.closed), true)
    await outcome('before-error')
    await waitState({ status: 'anonymous', error: 'fixed caller error' })
  })
  await check('current login, reauth and malformed-read errors keep their public contracts', async () => {
    plan('POST', 'login', errorBody('Login denied', 'denied'), { status: 403 })
    await run('login-denied', 'login', 'B@fixture.invalid', 'synthetic-password')
    const login = await outcome('login-denied')
    assert.equal(login.code, 'login_failed')
    assert.equal(login.status, 403)
    assert.equal(login.message, 'Login denied')
    plan('POST', 'reauth', errorBody('Reauth denied', 'reauth_denied'), { status: 403 })
    await run('reauth-denied', 'reauth', 'synthetic-password')
    const reauth = await outcome('reauth-denied')
    assert.equal(reauth.code, 'reauth_denied')
    assert.equal(reauth.status, 403)
    assert.equal(reauth.message, 'Reauth denied')
    plan('GET', 'session', privateMarker, { raw: true })
    await run('malformed-read', 'refresh')
    await outcome('malformed-read')
    await waitState({ status: 'anonymous', error: '响应内容无法读取，请刷新页面确认操作结果。' })
    assert.equal((await snapshot()).error.includes(privateMarker), false)
    plan('POST', 'logout', errorBody(privateMarker), { status: 503 })
    await run('logout-failure', 'logout')
    assert.equal((await outcome('logout-failure')).ok, true)
    assert.equal((await snapshot()).status, 'anonymous')
    assert.equal((await snapshot()).error, undefined)
  })
  assert.deepEqual(browserErrors, [], 'no uncaught browser errors')
  console.log(`${passed} passed; ${failures.length} failed; client lifecycle only`)
  if (failures.length) process.exitCode = 1
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}
