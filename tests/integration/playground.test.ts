import { createServer, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { pool } from '@/db'
import { POST as models } from '@/app/api/playground/models/route'
import { POST as chat } from '@/app/api/playground/chat/route'
import { createSession, SESSION_COOKIE } from '@/lib/auth/sessions'
import { sha256hex } from '@/lib/crypto'
import { getRootLogger } from '../../packages/observability/logger'
import { PLAYGROUND_LIMITS } from '../../packages/contracts/playground'

const database = new URL(process.env.DATABASE_URL || 'https://invalid')
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['127.0.0.1', 'localhost'].includes(database.hostname) ||
  database.port !== '55439' ||
  database.search ||
  database.hash ||
  !['/convergence_playground_test', '/convergence_ci15'].includes(database.pathname)
)
  throw new Error('Explicit disposable Playground database required')
const cookies: Record<string, string> = {}
const key = 'sk-nx-playground-fixture-01234567890123456789'
const otherKey = 'sk-nx-other-project-fixture-01234567890123456789'
const foreignKey = 'sk-nx-foreign-fixture-01234567890123456789'
const prompt = 'PRIVATE_PLAYGROUND_NATIVE_PROMPT'
const privateOutput = 'PRIVATE_PLAYGROUND_NATIVE_OUTPUT'
const input = () => ({
  projectId: 'project-a',
  apiKey: key,
  model: 'native-model',
  messages: [{ role: 'user', content: prompt }],
  maxTokens: 32,
})
const envelope = (content = privateOutput) => ({
  object: 'chat.completion',
  id: 'completion-id',
  model: 'native-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
})
let server: Server,
  base = '',
  calls = 0,
  mode = 'normal',
  pending: ServerResponse | undefined
let started: (() => void) | undefined
const dispatched: { method: string; url: string; headers: Record<string, unknown>; body: unknown }[] = []
const logger = vi.spyOn(getRootLogger(), 'error')
const originalGateway = process.env.NEXUS_GATEWAY_URL
const originalPublic = process.env.NEXT_PUBLIC_GATEWAY_BASE_URL

function request(body: unknown = input(), role = 'owner', signal?: AbortSignal, csrf = true) {
  return new Request('http://console.example/api/playground', {
    method: 'POST',
    signal,
    headers: {
      cookie: `${cookies[role] || ''}; nexus_csrf=native-playground`,
      ...(csrf ? { 'x-csrf-token': 'native-playground' } : {}),
      'content-type': 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}
async function invoke(route: typeof chat, body: unknown = input(), role = 'owner', signal?: AbortSignal, csrf = true) {
  const response = await route(request(body, role, signal, csrf))
  expect(response.headers.get('cache-control')).toBe('no-store')
  return { status: response.status, body: await response.json() }
}
async function alterKey(sql: string, values: unknown[] = []) {
  await pool.query(`UPDATE downstream_api_keys SET ${sql} WHERE id='key'`, values)
}
beforeAll(async () => {
  const actual = (await pool.query('SELECT current_database() AS name')).rows[0].name
  if (actual !== database.pathname.slice(1)) throw new Error('Playground fixture actual database mismatch')
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const runner = '../../scripts/db-migrate.mjs'
  const { runMigrations } = await import(runner)
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES ('org','tenant','Org','playground-native'),('foreign','foreign','Foreign','playground-foreign');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES ('project-a','tenant','org','A'),('project-b','tenant','org','B'),('archived','tenant','org','Archived'),('foreign','foreign','foreign','Foreign');
    UPDATE projects SET archived_at=now() WHERE id='archived'`)
  for (const role of ['owner', 'admin', 'developer', 'viewer', 'billing']) {
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      role,
      `playground-${role}@example.invalid`,
      'fixture',
    ])
    await pool.query(
      "INSERT INTO organization_memberships(organization_id,tenant_id,user_id,role) VALUES('org','tenant',$1,$2::member_role)",
      [role, role],
    )
    cookies[role] = `${SESSION_COOKIE}=${(await createSession({ userId: role })).token}`
  }
  await pool.query(
    "INSERT INTO project_memberships(tenant_id,project_id,user_id,role) VALUES('tenant','project-a','developer','viewer')",
  )
  for (const [id, token, tenant, organization, project] of [
    ['key', key, 'tenant', 'org', 'project-a'],
    ['other-key', otherKey, 'tenant', 'org', 'project-b'],
    ['foreign-key', foreignKey, 'foreign', 'foreign', 'foreign'],
  ]) {
    await pool.query(
      'INSERT INTO downstream_api_keys(id,tenant_id,organization_id,project_id,name,hash,prefix,scopes) VALUES($1,$2,$3,$4,$1,$5,\'sk-nx-\',\'["models:read","chat:write"]\')',
      [id, tenant, organization, project, sha256hex(token)],
    )
  }
  server = createServer(async (req, res) => {
    try {
      calls++
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString()
      dispatched.push({
        method: req.method || '',
        url: req.url || '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      })
      if (mode === 'redirect') {
        res.writeHead(307, { location: base + '/redirect-target' })
        res.end()
        return
      }
      if (mode === 'rejected') {
        res.writeHead(403)
        res.end('PRIVATE_UPSTREAM_DIAGNOSTIC')
        return
      }
      if (mode === 'pending' || mode === 'partial') {
        pending = res
        if (mode === 'partial') {
          res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'partial' })
          res.write('{"private":"')
        }
        started?.()
        return
      }
      if (mode === 'compressed-oversized') {
        const compressed = gzipSync('x'.repeat(PLAYGROUND_LIMITS.responseBytes + 1))
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': compressed.byteLength,
        })
        res.end(compressed)
        return
      }
      if (mode === 'body-error') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{"PRIVATE_BODY_READ_DIAGNOSTIC":')
        setImmediate(() => res.destroy())
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'gateway-native-request' })
      if (mode === 'malformed') res.end('{"PRIVATE_UPSTREAM_DIAGNOSTIC":')
      else if (mode === 'oversized') res.end('x'.repeat(PLAYGROUND_LIMITS.responseBytes + 1))
      else if (mode === 'invalid-envelope') res.end(JSON.stringify({ ...envelope(), choices: [] }))
      else if (req.url === '/v1/models')
        res.end(
          JSON.stringify({ object: 'list', data: [{ id: 'native-model', secret_metadata: 'PRIVATE_MODEL_METADATA' }] }),
        )
      else if (mode === 'semantic')
        res.end(
          JSON.stringify({
            ...envelope(),
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: privateOutput,
                  reasoning_content: '',
                  tool_calls: [],
                  refusal: '',
                },
                finish_reason: 'stop',
              },
            ],
          }),
        )
      else if (mode === 'tool-only')
        res.end(
          JSON.stringify({
            ...envelope(),
            choices: [{ index: 0, message: { role: 'assistant', tool_calls: [] }, finish_reason: 'tool_calls' }],
          }),
        )
      else if (mode === 'unknown') res.end(JSON.stringify({ ...envelope(), usage: null }))
      else if (mode === 'exact-bound') {
        const rawEnvelope = JSON.stringify(envelope(''))
        res.end(JSON.stringify(envelope('x'.repeat(PLAYGROUND_LIMITS.responseBytes - Buffer.byteLength(rawEnvelope)))))
      } else res.end(JSON.stringify(envelope()))
    } catch {
      res.writeHead(500)
      res.end('fixture failed')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.NEXUS_GATEWAY_URL = base + '/ignored-base'
}, 30_000)
afterAll(async () => {
  pending?.destroy()
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  if (originalGateway === undefined) delete process.env.NEXUS_GATEWAY_URL
  else process.env.NEXUS_GATEWAY_URL = originalGateway
  if (originalPublic === undefined) delete process.env.NEXT_PUBLIC_GATEWAY_BASE_URL
  else process.env.NEXT_PUBLIC_GATEWAY_BASE_URL = originalPublic
  logger.mockRestore()
})

it('actual session/CSRF routes discover models and forward one buffered multi-turn request', async () => {
  const before = calls
  const discovery = await invoke(models, { projectId: 'project-a', apiKey: key })
  expect(discovery).toEqual({
    status: 200,
    body: { version: 1, models: [{ id: 'native-model' }], requestId: 'gateway-native-request' },
  })
  const conversation = {
    ...input(),
    messages: [
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Previous reply' },
      { role: 'user', content: prompt },
    ],
  }
  const result = await invoke(chat, conversation, 'developer')
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({
    requestId: 'gateway-native-request',
    assistant: { content: privateOutput, refusal: null },
    canContinue: true,
    usage: { inputTokens: '10', outputTokens: '0', totalTokens: '10', cachedInputTokens: null, reasoningTokens: null },
  })
  expect(calls - before).toBe(2)
  expect(dispatched.slice(-2).map(({ method, url }) => ({ method, url }))).toEqual([
    { method: 'GET', url: '/v1/models' },
    { method: 'POST', url: '/v1/chat/completions' },
  ])
  expect(dispatched.at(-1)?.body).toEqual({
    model: 'native-model',
    messages: conversation.messages,
    max_tokens: 32,
    stream: false,
  })
  const headers = dispatched.at(-1)!.headers
  expect(headers.authorization).toBe(`Bearer ${key}`)
  for (const header of ['cookie', 'x-csrf-token', 'x-request-id', 'x-tenant-id', 'x-project-id'])
    expect(headers).not.toHaveProperty(header)
})
it.each(['viewer', 'billing', 'missing'])(
  '%s cannot discover or execute through read-only dashboard access',
  async (role) => {
    const before = calls
    for (const [route, body] of [
      [chat, input()],
      [models, { projectId: 'project-a', apiKey: key }],
    ] as const)
      expect((await invoke(route, body, role)).status).toBe(role === 'missing' ? 401 : 403)
    expect(calls).toBe(before)
  },
)
it('missing CSRF blocks both operations before dispatch', async () => {
  const before = calls
  expect((await invoke(chat, input(), 'owner', undefined, false)).status).toBe(403)
  expect((await invoke(models, { projectId: 'project-a', apiKey: key }, 'owner', undefined, false)).status).toBe(403)
  expect(calls).toBe(before)
})
it.each(['project-b', 'archived', 'foreign', 'missing'])(
  'hidden/inactive project %s produces uniform 404 without dispatch',
  async (projectId) => {
    const before = calls
    const result = await invoke(chat, { ...input(), projectId }, 'developer')
    expect(result).toEqual({ status: 404, body: { error: { code: 'tenant_isolation', message: '项目不存在' } } })
    expect(calls).toBe(before)
  },
)
it.each(['admin', 'owner'])('%s still needs an exact project-bound Key', async (role) => {
  const before = calls
  for (const apiKey of [otherKey, foreignKey, 'sk-nx-missing-fixture-01234567890123456789'])
    expect((await invoke(chat, { ...input(), apiKey }, role)).status).toBe(403)
  expect(calls).toBe(before)
})
it.each([
  'enabled=false',
  'revoked_at=now()',
  'deleted_at=now()',
  "expires_at=now()-interval '1 second'",
  'project_id=NULL',
])('Key %s fails before dispatch', async (change) => {
  const before = calls
  await alterKey(change)
  try {
    expect((await invoke(chat)).status).toBe(403)
  } finally {
    await alterKey("enabled=true,revoked_at=NULL,deleted_at=NULL,expires_at=NULL,project_id='project-a'")
  }
  expect(calls).toBe(before)
})
it.each([{}, 'chat:write', ['chat:write', 1], [], ['models:read']])(
  'actual stored invalid/chat-denied scopes %j fail closed',
  async (scopes) => {
    const before = calls
    await alterKey('scopes=$1::jsonb', [JSON.stringify(scopes)])
    try {
      expect((await invoke(chat)).status).toBe(403)
    } finally {
      await alterKey('scopes=$1::jsonb', [JSON.stringify(['models:read', 'chat:write'])])
    }
    expect(calls).toBe(before)
  },
)
it('models and chat require distinct operation scopes including existing prefix matching', async () => {
  await alterKey('scopes=$1::jsonb', [JSON.stringify(['chat:*'])])
  try {
    const before = calls
    expect((await invoke(models, { projectId: 'project-a', apiKey: key })).status).toBe(403)
    expect(calls).toBe(before)
    expect((await invoke(chat)).status).toBe(200)
    await alterKey('scopes=$1::jsonb', [JSON.stringify(['models:*'])])
    expect((await invoke(chat)).status).toBe(403)
    expect((await invoke(models, { projectId: 'project-a', apiKey: key })).status).toBe(200)
  } finally {
    await alterKey('scopes=$1::jsonb', [JSON.stringify(['models:read', 'chat:write'])])
  }
})
it.each(["status='paused'", 'archived_at=now()'])('inactive project %s is denied to owner as well', async (change) => {
  const before = calls
  await pool.query(`UPDATE projects SET ${change} WHERE id='project-a'`)
  try {
    expect((await invoke(chat)).status).toBe(404)
  } finally {
    await pool.query("UPDATE projects SET status='active',archived_at=NULL WHERE id='project-a'")
  }
  expect(calls).toBe(before)
})
it('disabled organization removes principal and prevents Gateway dispatch', async () => {
  const before = calls
  await pool.query("UPDATE organizations SET status='disabled' WHERE id='org'")
  try {
    expect((await invoke(chat)).status).toBe(401)
  } finally {
    await pool.query("UPDATE organizations SET status='active' WHERE id='org'")
  }
  expect(calls).toBe(before)
})
it.each(['malformed', 'oversized', 'compressed-oversized', 'body-error', 'invalid-envelope', 'redirect', 'rejected'])(
  '%s Gateway result is fixed, never leaked and never replayed',
  async (failure) => {
    const before = calls
    mode = failure
    try {
      const result = await invoke(chat)
      expect(result.status).toBe(failure === 'rejected' ? 403 : 502)
      expect(result.body.error.code).toBe(
        failure === 'rejected' ? 'playground_gateway_rejected' : 'playground_delivery_unknown',
      )
      expect(JSON.stringify(result.body)).not.toContain('PRIVATE')
      expect(calls - before).toBe(1)
    } finally {
      mode = 'normal'
    }
    expect((await invoke(chat)).status).toBe(200)
    expect(calls - before).toBe(2)
  },
)
it('preserves unknown counters and empty semantic fields without safe-replay claims', async () => {
  mode = 'unknown'
  try {
    expect((await invoke(chat)).body.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    })
  } finally {
    mode = 'normal'
  }
  mode = 'semantic'
  try {
    expect((await invoke(chat)).body).toMatchObject({
      canContinue: false,
      assistant: { content: privateOutput, refusal: '' },
    })
  } finally {
    mode = 'normal'
  }
})
it('accepts the exact decoded response byte cap', async () => {
  mode = 'exact-bound'
  try {
    expect((await invoke(chat)).status).toBe(200)
  } finally {
    mode = 'normal'
  }
})
it('tool-only reply without visible content is explicit and cannot be replayed as text', async () => {
  mode = 'tool-only'
  try {
    expect(await invoke(chat)).toMatchObject({
      status: 200,
      body: { assistant: { content: null, refusal: null }, canContinue: false, finishReason: 'tool_calls' },
    })
  } finally {
    mode = 'normal'
  }
})
it('bounds UTF-8 input bytes before parse and keeps syntax errors away from the logger', async () => {
  const before = calls,
    logs = logger.mock.calls.length
  const exact = input()
  exact.messages[0].content = 'x'.repeat(
    PLAYGROUND_LIMITS.inputBytes -
      Buffer.byteLength(JSON.stringify({ ...exact, messages: [{ role: 'user', content: '' }] })),
  )
  expect(Buffer.byteLength(JSON.stringify(exact))).toBe(PLAYGROUND_LIMITS.inputBytes)
  expect((await invoke(chat, exact)).status).toBe(200)
  expect(
    (await invoke(chat, { ...exact, messages: [{ role: 'user', content: exact.messages[0].content + '多' }] })).status,
  ).toBe(413)
  expect((await invoke(chat, '{"PRIVATE_REQUEST_SYNTAX":')).status).toBe(400)
  expect(calls - before).toBe(1)
  expect(logger.mock.calls.length).toBe(logs)
})
it.each(['pending', 'partial'])(
  'cancellation during %s aborts forwarding and does not replay or leak body',
  async (phase) => {
    const before = calls
    mode = phase
    const controller = new AbortController()
    const received = new Promise<void>((resolve) => {
      started = resolve
    })
    const result = invoke(chat, input(), 'owner', controller.signal)
    try {
      await received
      controller.abort()
      expect(await result).toMatchObject({ status: 504, body: { error: { code: 'playground_delivery_unknown' } } })
      expect(calls - before).toBe(1)
    } finally {
      pending?.destroy()
      pending = undefined
      started = undefined
      mode = 'normal'
    }
    expect((await invoke(chat)).status).toBe(200)
  },
)
it('invalid configured destination cannot dispatch and public base is an explicit fallback only', async () => {
  const before = calls
  process.env.NEXUS_GATEWAY_URL = base + '?'
  try {
    expect((await invoke(chat)).body.error.code).toBe('gateway_invalid_destination')
  } finally {
    process.env.NEXUS_GATEWAY_URL = base
  }
  expect(calls).toBe(before)
  delete process.env.NEXUS_GATEWAY_URL
  process.env.NEXT_PUBLIC_GATEWAY_BASE_URL = base
  try {
    expect((await invoke(chat)).status).toBe(200)
  } finally {
    process.env.NEXUS_GATEWAY_URL = base
    delete process.env.NEXT_PUBLIC_GATEWAY_BASE_URL
  }
})
it('Control Plane records only dispatch intent and never writes inference/accounting or last-used facts', async () => {
  expect(
    (await pool.query("SELECT last_used_at FROM downstream_api_keys WHERE id='key'")).rows[0].last_used_at,
  ).toBeNull()
  const audit = (
    await pool.query(
      "SELECT action,target_id,metadata FROM audit_events WHERE action LIKE 'playground.%' ORDER BY created_at",
    )
  ).rows
  expect(audit.length).toBeGreaterThan(0)
  expect(
    audit.every(
      (row) =>
        row.action === 'playground.dispatch_intent' &&
        row.target_id === 'project-a' &&
        Object.keys(row.metadata).sort().join(',') === 'keyId,operation',
    ),
  ).toBe(true)
  const serialized = JSON.stringify(audit)
  for (const canary of [key, otherKey, foreignKey, prompt, privateOutput, 'PRIVATE_UPSTREAM_DIAGNOSTIC'])
    expect(serialized).not.toContain(canary)
  for (const table of [
    'request_records',
    'attempts',
    'outbox_events',
    'usage_events',
    'usage_records',
    'ledger_transactions',
    'ledger_postings',
  ])
    expect((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0)
  expect(logger).not.toHaveBeenCalled()
})
