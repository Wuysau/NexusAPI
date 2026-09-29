import { Pool } from 'pg'
import { mkdtemp, writeFile, rm, utimes, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { configureObserver, scanCodex } from '../../src/lib/observer/importer'
import { AGENT_TOOLS } from '../../src/lib/observer/agent-tools'
import { queryUsageAnalytics } from '../../src/lib/billing/analytics'
import { readSessionDetails } from '../../src/lib/billing/sessions'
import { parseUsageAnalyticsQuery, validateUsageAnalyticsResponse } from '../../packages/contracts/usage-analytics'
const database = new URL(process.env.DATABASE_URL || 'https://invalid')
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || !/test|ci/.test(database.pathname))
  throw new Error('Disposable local database required')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const runner = '../../scripts/db-migrate.mjs'
const { runMigrations } = await import(runner)
const dir = await mkdtemp(path.join(tmpdir(), 'nexus-agent-import-'))
const scope = { tenantId: 'agent-tenant', organizationId: 'agent-org' }
const config = {
  ...scope,
  sources: [],
  roots: [{ root: 'D:/AgentProject', projectId: 'agent-project' }],
  providers: [],
  autoDiscover: false,
  agentSources: AGENT_TOOLS.map((t) => ({
    tool: t.id,
    path: path.join(dir, t.id + '.jsonl'),
    format: 'telemetry' as const,
  })),
}
const access = {
  tenantId: scope.tenantId,
  organizations: [{ organizationId: scope.organizationId, allProjects: true, projectIds: [] }],
  financialOrganizationId: null,
}
const timestamp = new Date(Date.now() - 60000).toISOString()
const event = (tool: string, tokens: Record<string, string> | undefined = undefined) => ({
  schemaVersion: 1,
  tool,
  sessionId: 'shared-session',
  eventId: 'event-1',
  timestamp,
  cwd: 'D:/AgentProject',
  model: 'custom-model',
  tokens,
  content: 'PRIVATE_PROMPT_CANARY',
  authorization: 'PRIVATE_AUTH_CANARY',
})
const query = (source = 'all') =>
  parseUsageAnalyticsQuery(
    new URLSearchParams({
      from: new Date(Date.now() - 3600000).toISOString(),
      to: new Date().toISOString(),
      usageSource: source,
      groupBy: 'usageSource',
    }),
  )
beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await runMigrations(pool)
  await pool.query(`INSERT INTO organizations(id,tenant_id,name,slug) VALUES('agent-org','agent-tenant','Agents','agents');
    INSERT INTO projects(id,tenant_id,organization_id,name) VALUES('agent-project','agent-tenant','agent-org','Agent Project')`)
  await configureObserver(pool, config)
  for (const source of config.agentSources) await writeFile(source.path, JSON.stringify(event(source.tool)) + '\n')
})
afterAll(async () => {
  await pool.end()
  await rm(dir, { recursive: true, force: true })
})
it('accepts every catalog tool, source-aware session IDs, no content persistence or financial side effects', async () => {
  const result = await scanCodex(pool, config)
  expect(result.sourceErrors).toEqual([])
  expect(result.newEvents).toBe(AGENT_TOOLS.length)
  expect(result.newSessions).toBe(AGENT_TOOLS.length)
  expect(result.groups[0].sessions).toBe(AGENT_TOOLS.length)
  const report = await queryUsageAnalytics(pool, access, query())
  expect(validateUsageAnalyticsResponse(report)).toEqual({ ok: true, errors: [] })
  expect(report.totals.sessions).toBe(String(AGENT_TOOLS.length))
  expect(report.totals.tokens.total.total).toBeNull()
  expect(report.totals.provenance?.length).toBe(AGENT_TOOLS.length)
  expect((await readSessionDetails(pool, access, query(), null)).sessions).toHaveLength(AGENT_TOOLS.length)
  for (const table of ['external_observed_usage', 'observer_scan_cursors'])
    expect(JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows)).not.toContain('PRIVATE_')
  for (const table of ['ledger_transactions', 'request_records', 'usage_events'])
    expect((await pool.query(`SELECT * FROM ${table}`)).rowCount).toBe(0)
})
it('fills unknown tokens on rewritten snapshots and rejects scope/provenance/token downgrades', async () => {
  const file = config.agentSources.find((s) => s.tool === 'cursor')!.path
  await writeFile(
    file,
    JSON.stringify(event('cursor', { input: '100', output: '20', cached: '0', reasoning: '0', total: '120' })) + '\n',
  )
  await utimes(file, new Date(), new Date(Date.now() + 1000))
  expect((await scanCodex(pool, config)).updatedEvents).toBe(1)
  expect((await scanCodex(pool, config)).newEvents).toBe(0)
  const copy = path.join(dir, 'cursor-copy.jsonl')
  await copyFile(file, copy)
  expect(
    (await scanCodex(pool, { ...config, agentSources: [{ tool: 'cursor', path: copy, format: 'telemetry' }] }))
      .newEvents,
  ).toBe(0)
  expect((await queryUsageAnalytics(pool, access, query('agent:cursor'))).totals.tokens.total.total).toBe('120')
  await expect(
    pool.query("UPDATE external_observed_usage SET output_tokens=0,total_tokens=100 WHERE usage_source='agent:cursor'"),
  ).rejects.toThrow('immutable')
  await expect(
    pool.query("UPDATE external_observed_usage SET connection_id='fake' WHERE usage_source='agent:cursor'"),
  ).rejects.toThrow('immutable')
})
it('keeps isolation and accepts a future tool without schema changes', async () => {
  const file = path.join(dir, 'future_agent.jsonl')
  await writeFile(file, JSON.stringify(event('future_agent')) + '\n')
  expect(
    (await scanCodex(pool, { ...config, agentSources: [{ tool: 'future_agent', path: file, format: 'telemetry' }] }))
      .newEvents,
  ).toBe(1)
  const report = await queryUsageAnalytics(pool, access, query('agent:future_agent'))
  expect(report.totals.observedEvents).toBe('1')
  expect(report.totals.provenance?.[0].source).toBe('agent:future_agent')
  expect((await queryUsageAnalytics(pool, { ...access, tenantId: 'other' }, query())).totals.observedEvents).toBe('0')
  expect((await queryUsageAnalytics(pool, { ...access, organizations: [] }, query())).totals.observedEvents).toBe('0')
})
it('isolates malformed sources while importing an independently valid native Gemini session', async () => {
  const file = path.join(dir, 'session-gemini.json')
  await writeFile(
    file,
    JSON.stringify({
      sessionId: 'gemini-session',
      startTime: timestamp,
      messages: [
        {
          id: 'msg',
          type: 'gemini',
          timestamp,
          model: 'gemini-test',
          tokens: { input: 10, output: 3, cached: 0, thoughts: 2, total: 15 },
        },
      ],
    }),
  )
  const result = await scanCodex(pool, {
    ...config,
    agentSources: [
      { tool: 'gemini_cli', path: file, format: 'native', workspace: 'D:/AgentProject' },
      { tool: 'cline', path: path.join(dir, 'missing'), format: 'native' },
    ],
  })
  expect(result.newEvents).toBe(1)
  expect(result.sourceErrors).toEqual([{ tool: 'cline', code: 'source_unavailable' }])
  expect((await queryUsageAnalytics(pool, access, query('agent:gemini_cli'))).totals.observedEvents).toBe('2')
})

it('merges missing counters and total-only enrichment, skipping incompatible revisions without losing new events', async () => {
  const tool = 'partial_test'
  const file = path.join(dir, tool + '.jsonl')
  const scoped = { ...config, agentSources: [{ tool, path: file, format: 'telemetry' as const }] }
  let revision = 0
  const scan = async (rows: ReturnType<typeof event>[]) => {
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    await utimes(file, new Date(), new Date(Date.now() + ++revision * 1000))
    return scanCodex(pool, scoped)
  }
  expect((await scan([event(tool, { input: '100', cached: '10' })])).newEvents).toBe(1)
  expect((await scan([event(tool, { output: '20' })])).updatedEvents).toBe(1)
  expect((await scan([event(tool, { total: '120' })])).updatedEvents).toBe(1)
  const read = () =>
    pool.query(
      `SELECT input_tokens,cached_input_tokens,output_tokens,total_tokens FROM external_observed_usage
     WHERE usage_source=$1 AND external_session_id='shared-session'`,
      ['agent:' + tool],
    )
  const expected = { input_tokens: '100', cached_input_tokens: '10', output_tokens: '20', total_tokens: '120' }
  expect((await read()).rows).toEqual([expected])
  // Each incoming partial record is valid by itself, but cannot safely revise the stored fact.
  const incompatible: Record<string, string>[] = [
    { total: '119' },
    { output: '19' },
    { output: '21' },
    { cached: '101' },
    { reasoning: '21' },
  ]
  for (const tokens of incompatible) {
    const result = await scan([
      event(tool, tokens),
      { ...event(tool), eventId: 'new-' + revision, sessionId: 'new-' + revision },
    ])
    expect(result.sourceErrors).toEqual([])
    expect(result.updatedEvents).toBe(0)
    expect(result.newEvents).toBe(1)
    expect((await read()).rows).toEqual([expected])
  }
})

it('discards rolled-back file deltas so healthy duplicate files recover events and reports deduplicate errors', async () => {
  const tool = 'rollback_test'
  const failed = path.join(dir, 'rollback-a.jsonl')
  const failedAgain = path.join(dir, 'rollback-b.jsonl')
  const healthy = path.join(dir, 'rollback-c.jsonl')
  const recovered = { ...event(tool), eventId: 'recovered', sessionId: 'recovered' }
  const rejected = { ...event(tool), eventId: 'rejected', sessionId: 'reject-fixture' }
  const rolledBack = { ...event(tool), eventId: 'rolled-back', sessionId: 'rolled-back' }
  await writeFile(failed, [rolledBack, recovered, rejected].map((row) => JSON.stringify(row)).join('\n') + '\n')
  await copyFile(failed, failedAgain)
  await writeFile(healthy, JSON.stringify(recovered) + '\n')
  const scoped = {
    ...config,
    agentSources: [failed, failedAgain, healthy].map((file) => ({ tool, path: file, format: 'telemetry' as const })),
  }
  // Inject a genuine database failure after successful INSERTs to exercise transaction rollback.
  await pool.query(`CREATE FUNCTION reject_agent_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.external_session_id='reject-fixture' THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_agent_fixture BEFORE INSERT ON external_observed_usage FOR EACH ROW EXECUTE FUNCTION reject_agent_fixture()`)
  try {
    const result = await scanCodex(pool, scoped)
    expect(result.sourceErrors).toEqual([{ tool, code: 'capture_failed' }])
    expect(result.newEvents).toBe(1)
    expect(result.newSessions).toBe(1)
    expect(result.skippedDuplicates).toBe(0)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({ sessions: 1, usageEvents: 1 })
    expect(
      (
        await pool.query('SELECT external_session_id FROM external_observed_usage WHERE usage_source=$1', [
          'agent:' + tool,
        ])
      ).rows,
    ).toEqual([{ external_session_id: 'recovered' }])
    const repeated = await scanCodex(pool, scoped)
    expect(repeated.newEvents).toBe(0)
    expect(repeated.newSessions).toBe(0)
    expect(repeated.unchangedFiles).toBe(1)
    expect(repeated.sourceErrors).toEqual([{ tool, code: 'capture_failed' }])
  } finally {
    await pool.query(
      'DROP TRIGGER reject_agent_fixture ON external_observed_usage; DROP FUNCTION reject_agent_fixture()',
    )
  }
})
