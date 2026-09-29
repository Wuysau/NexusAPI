import { Pool } from 'pg'
import { mkdtemp, writeFile, appendFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { configureObserver, scanCodex } from '../../src/lib/observer/importer'
import { queryUsageAnalytics } from '../../src/lib/billing/analytics'
import { readSessionDetails } from '../../src/lib/billing/sessions'
import { parseUsageAnalyticsQuery, validateUsageAnalyticsResponse } from '../../packages/contracts/usage-analytics'

const url = new URL(process.env.DATABASE_URL || 'https://invalid')
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/test|ci/.test(url.pathname))
  throw new Error('Explicit local disposable test DB required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const dir = await mkdtemp(path.join(tmpdir(), 'claude-observer-'))
const file = path.join(dir, 'session.jsonl')
const scope = { tenantId: 'claude-tenant', organizationId: 'claude-org' }
const config = {
  ...scope,
  sources: [],
  claudeSources: [file],
  roots: [{ root: 'D:/Nexus', projectId: 'claude-project' }],
  providers: [],
}
const access = {
  tenantId: scope.tenantId,
  organizations: [{ organizationId: scope.organizationId, allProjects: true, projectIds: [] }],
  financialOrganizationId: null,
}
const timestamp = new Date(Date.now() - 60000).toISOString()
const event = (output = 5) => ({
  type: 'assistant',
  sessionId: 'session-a',
  uuid: 'block-' + output,
  cwd: 'D:/Nexus',
  timestamp,
  version: '2.1',
  message: {
    id: 'message-a',
    model: 'glm-5.2',
    content: [{ text: 'PRIVATE_PROMPT_RESPONSE' }],
    usage: { input_tokens: 20, cache_creation_input_tokens: 10, cache_read_input_tokens: 30, output_tokens: output },
  },
})
const lines = (...e: unknown[]) => e.map((x) => JSON.stringify(x)).join('\n') + '\n'
const query = (source = 'all') =>
  parseUsageAnalyticsQuery(
    new URLSearchParams({
      from: new Date(Date.now() - 3600000).toISOString(),
      to: new Date().toISOString(),
      usageSource: source,
      groupBy: 'model',
    }),
  )
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES('claude-org','claude-tenant','Claude','claude');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES('claude-project','claude-tenant','claude-org','Nexus')`)
  await configureObserver(pool, config)
  await writeFile(file, lines(event()))
})
afterAll(async () => {
  await pool.end()
  await rm(dir, { recursive: true, force: true })
})
it('captures custom-model local usage by project without inventing a connection or writing billing facts', async () => {
  expect((await scanCodex(pool, config)).newEvents).toBe(1)
  const row = (await pool.query('SELECT * FROM external_observed_usage')).rows[0]
  expect(row).toMatchObject({
    usage_source: 'claude_code_local',
    project_id: 'claude-project',
    provider: null,
    connection_id: null,
    subscription_product: null,
    input_tokens: '60',
    output_tokens: '5',
    total_tokens: '65',
    session_kind: 'cli',
  })
  for (const table of ['external_observed_usage', 'observer_scan_cursors'])
    expect(JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows)).not.toContain('PRIVATE_PROMPT_RESPONSE')
  for (const table of ['usage_events', 'usage_records', 'ledger_transactions', 'request_records'])
    expect((await pool.query(`SELECT * FROM ${table}`)).rowCount).toBe(0)
})
it('revises streamed blocks once, resumes partial tails and deduplicates file copies and earlier replay', async () => {
  const tail = JSON.stringify(event(12))
  await appendFile(file, tail.slice(0, -3))
  expect((await scanCodex(pool, config)).updatedEvents).toBe(0)
  await appendFile(file, tail.slice(-3) + '\n')
  expect((await scanCodex(pool, config)).updatedEvents).toBe(1)
  expect((await scanCodex(pool, config)).bytesRead).toBe(0)
  const copied = path.join(dir, 'copy.jsonl')
  await copyFile(file, copied)
  expect((await scanCodex(pool, { ...config, claudeSources: [copied] })).newEvents).toBe(0)
  const row = (await pool.query('SELECT output_tokens,total_tokens FROM external_observed_usage')).rows
  expect(row).toEqual([{ output_tokens: '12', total_tokens: '72' }])
  await expect(pool.query('UPDATE external_observed_usage SET output_tokens=1,total_tokens=61')).rejects.toThrow(
    'immutable',
  )
  await expect(pool.query("UPDATE external_observed_usage SET provider='anthropic'")).rejects.toThrow('immutable')
})
it('exposes Claude filtering and sessions, preserves tenant/project isolation and excludes gateway billing', async () => {
  const report = await queryUsageAnalytics(pool, access, query('claude_code_local'))
  expect(validateUsageAnalyticsResponse(report)).toEqual({ ok: true, errors: [] })
  expect(report.totals).toMatchObject({
    requests: '0',
    sessions: '1',
    observedEvents: '1',
    money: [],
    tokens: { total: { total: '72' } },
  })
  expect((await readSessionDetails(pool, access, query(), null)).sessions[0]).toMatchObject({
    usageSource: 'claude_code_local',
    models: ['glm-5.2'],
    connectionIds: [],
  })
  expect((await queryUsageAnalytics(pool, access, query('gateway'))).totals.observedEvents).toBe('0')
  expect((await queryUsageAnalytics(pool, { ...access, tenantId: 'other' }, query())).totals.observedEvents).toBe('0')
  expect(
    (
      await queryUsageAnalytics(
        pool,
        { ...access, organizations: [{ organizationId: scope.organizationId, allProjects: false, projectIds: [] }] },
        query(),
      )
    ).totals.observedEvents,
  ).toBe('0')
})
