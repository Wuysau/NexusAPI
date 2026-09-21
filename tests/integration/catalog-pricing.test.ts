// Integration tests for Work Item D — dynamic catalog and pricing.
//
// Requires a real Postgres (DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db).
// Resets the public schema and applies migrations 0000, 0001 and 0002 so it is
// independent of test ordering.
//
// Covers the eight scenarios required by the brief plus the contract surfaces:
//   1. duplicate / concurrent sync          → one candidate, no effective range
//   2. page structure change                → active kept, alert, no zero price
//   3. price increase                       → high-risk, manual approval, supersede
//   4. currency change                      → high-risk, never automatic
//   5. time-range overlap                   → backdated activation refused
//   6. scheduled activation                 → signed snapshot at effective time
//   7. emergency rollback                   → new version, history untouched
//   8. historical recompute                 → pinned version re-derives exactly
// Plus: provider source registry, lifecycle machine, approval RBAC, fixtures
// against contracts/price-record.schema.json, legacy price-shim isolation.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { Pool } from 'pg'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runCatalogSync, parsePricePayload, priceVersionIdForCandidate } from '@/lib/catalog/sync'
import { approvePriceCandidate } from '@/lib/catalog/approval'
import { emergencyRollback, runActivationJob } from '@/lib/catalog/activation'
import {
  builtinSourceAdapters,
  classifyUpstreamError,
  createSourceRegistry,
  type PriceSourcePayload,
} from '@/lib/catalog/registry'
import { canAutoActivate, canTransition } from '@/lib/catalog/lifecycle'
import { verifySnapshot } from '@/lib/catalog/snapshot'
import { UpstreamError } from '@/lib/providers/openai-compatible'
import { recomputeCharge, ROUNDING_VERSION } from '@/lib/pricing/recompute'
import { validatePriceRecord, type PriceComponent } from '@/lib/pricing/components'
import { sha256hex } from '@/lib/crypto'
import type { Principal } from '@/lib/auth/capabilities'
import type { NormalizedModel } from '@/lib/providers/types'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/app_db'
const pool = new Pool({ connectionString: DATABASE_URL })

function readMigration(name: string): string {
  return readFileSync(join(process.cwd(), 'drizzle', name), 'utf-8')
}

async function resetDatabase() {
  const client = await pool.connect()
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('CREATE SCHEMA public')
    await client.query('GRANT ALL ON SCHEMA public TO postgres')
    await client.query('GRANT ALL ON SCHEMA public TO public')
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await client.query(readMigration('0000_left_nekra.sql'))
    await client.query(readMigration('0001_greedy_shape.sql'))
    await client.query(readMigration('0002_auth_secret_plane.sql'))
  } finally {
    client.release()
  }
}

// ── Fixtures / helpers ─────────────────────────────────────────────────

let providerId: string
let adminId: string
let adminPrincipal: Principal

// Every generated record gets a strictly increasing past effective_from so a
// later version can supersede an earlier one without overlap conflicts.
const PAST_BASE = Date.now() - 86_400_000
let seq = 0
function nextPast(): Date {
  return new Date(PAST_BASE + seq++ * 1000)
}
function futureDate(ms = 3_600_000): Date {
  return new Date(Date.now() + ms)
}

function comp(kind: PriceComponent['kind'], amount: string, unit = 'per_million_tokens'): PriceComponent {
  return { kind, unit, amount, conditions: {} }
}

function rec(
  modelId: string,
  components: PriceComponent[],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    provider: 'openai',
    model_id: modelId,
    currency: 'USD',
    status: 'pending_approval',
    effective_from: nextPast().toISOString(),
    effective_to: null,
    components,
    source: {
      url: 'https://api.openai.com/v1/pricing',
      retrieved_at: new Date().toISOString(),
      content_sha256: sha256hex(JSON.stringify({ modelId, components })),
    },
    approved_by: null,
    approved_at: null,
    ...over,
  }
}

function payload(records: unknown[], over: Partial<PriceSourcePayload> = {}): PriceSourcePayload {
  const body = JSON.stringify({ prices: records })
  return {
    sourceType: 'official_api',
    url: 'https://api.openai.com/v1/pricing',
    retrievedAt: new Date(),
    contentType: 'application/json',
    body,
    parserVersion: 'nexus-price-parser@1',
    region: 'global',
    currency: 'USD',
    ...over,
  }
}

function discoverModels(ids: string[]) {
  return async (): Promise<NormalizedModel[]> =>
    ids.map((id) => ({ upstreamModelId: id, displayName: id, capabilities: [], lifecycle: 'pending_review' }))
}

async function syncPrice(records: unknown[], models: string[]) {
  const source = payload(records)
  const result = await runCatalogSync({
    providerId,
    pricePayloads: [source],
    discoverModels: discoverModels(models),
    actorUserId: adminId,
  })
  expect(result.failed).toBe(false)
  return result
}

async function syncAndApprove(records: unknown[], modelId: string, effectiveFrom?: Date) {
  const result = await syncPrice(records, [modelId])
  expect(result.candidateIds).toHaveLength(1)
  const candidateId = result.candidateIds[0]
  const approved = await approvePriceCandidate({ candidateId, actor: adminPrincipal, effectiveFrom })
  expect(approved.status).toBe('active')
  return { candidateId, versionId: approved.versionId as string, approved }
}

async function activeRow(modelId: string) {
  const r = await pool.query(
    `SELECT * FROM provider_price_versions WHERE upstream_model_id = $1 AND status = 'active' LIMIT 1`,
    [modelId],
  )
  return r.rows[0] ?? null
}

async function versionRow(id: string) {
  const r = await pool.query('SELECT * FROM provider_price_versions WHERE id = $1', [id])
  return r.rows[0]
}

async function candidateRow(id: string) {
  const r = await pool.query('SELECT * FROM price_candidates WHERE id = $1', [id])
  return r.rows[0]
}

async function componentsFor(versionId: string): Promise<PriceComponent[]> {
  const r = await pool.query(
    'SELECT kind, unit, amount, conditions FROM price_components WHERE price_version_id = $1',
    [versionId],
  )
  return r.rows.map((row) => ({
    kind: row.kind,
    unit: row.unit,
    amount: row.amount,
    conditions: row.conditions ?? {},
  }))
}

function caps() {
  return {
    text: true,
    vision: false,
    audio: false,
    embeddings: false,
    reasoning: false,
    streaming: true,
    toolCalling: false,
    structuredOutput: false,
    promptCaching: false,
  }
}

beforeAll(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query(
    `TRUNCATE audit_events, outbox_events, sync_runs, gateway_snapshots, catalog_versions,
             price_components, price_candidates, price_sources, provider_price_versions,
             upstream_models, policy_versions, routing_policies, exchange_rate_snapshots,
             organization_memberships, users, organizations, providers CASCADE`,
  )
  const prov = await pool.query(
    `INSERT INTO providers (id, code, name, official_base_url, auth_scheme)
     VALUES (gen_random_uuid(), 'openai', 'OpenAI', 'https://api.openai.com/v1', 'bearer') RETURNING id`,
  )
  providerId = prov.rows[0].id

  const user = await pool.query(
    `INSERT INTO users (id, email, password_hash, status)
     VALUES (gen_random_uuid(), 'admin@example.test', 'x', 'active') RETURNING id`,
  )
  adminId = user.rows[0].id
  adminPrincipal = { kind: 'user', role: 'admin', userId: adminId }
})

// ── Provider source registry ───────────────────────────────────────────

describe('provider source adapter registry', () => {
  it('covers the five supported providers with observable versions', () => {
    const adapters = builtinSourceAdapters()
    expect(adapters.map((a) => a.id).sort()).toEqual(['anthropic', 'deepseek', 'gemini', 'openai', 'qwen'])
    for (const adapter of adapters) {
      expect(adapter.version).toBeTruthy()
      expect(typeof adapter.discoverModels).toBe('function')
      expect(typeof adapter.classifyError).toBe('function')
    }
  })

  it('adds a provider without modifying the sync core, and rejects duplicates', () => {
    const registry = createSourceRegistry()
    const before = registry.codes().length
    registry.register({
      id: 'mistral',
      version: '1.0.0',
      authScheme: 'bearer',
      discoverModels: async () => [],
      validateCredential: async () => ({ ok: true, verifiedAt: new Date().toISOString() }),
      capabilities: caps,
      classifyError: () => ({ kind: 'unknown', retryable: false }),
      health: async () => ({ ok: true, checkedAt: new Date().toISOString() }),
    })
    expect(registry.codes()).toContain('mistral')
    expect(registry.codes().length).toBe(before + 1)
    expect(registry.get('mistral')?.version).toBe('1.0.0')
    expect(() =>
      registry.register({
        id: 'mistral',
        version: '1.0.0',
        authScheme: 'bearer',
        discoverModels: async () => [],
        validateCredential: async () => ({ ok: true, verifiedAt: new Date().toISOString() }),
        capabilities: caps,
        classifyError: () => ({ kind: 'unknown', retryable: false }),
        health: async () => ({ ok: true, checkedAt: new Date().toISOString() }),
      }),
    ).toThrow(/already registered/)
  })

  it('classifies errors and never auto-retries', () => {
    expect(classifyUpstreamError(new UpstreamError('x', 401))).toEqual({ kind: 'auth', retryable: false })
    expect(classifyUpstreamError(new UpstreamError('x', 403))).toMatchObject({ kind: 'auth', retryable: false })
    expect(classifyUpstreamError(new UpstreamError('x', 429))).toMatchObject({ kind: 'rate_limit', retryable: true })
    expect(classifyUpstreamError(new UpstreamError('x', 503))).toMatchObject({ kind: 'provider_down', retryable: true })
    expect(classifyUpstreamError(new UpstreamError('x', 400))).toMatchObject({
      kind: 'invalid_request',
      retryable: false,
    })
    expect(classifyUpstreamError(new Error('boom')).retryable).toBe(false)
  })
})

// ── Contract fixtures ──────────────────────────────────────────────────

describe('price-record contract fixtures', () => {
  it('tests/fixtures/prices.json conforms to price-record.schema.json', () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/prices.json'), 'utf-8')) as {
      records: unknown[]
    }
    expect(raw.records.length).toBeGreaterThan(0)
    for (const record of raw.records) {
      expect(validatePriceRecord(record)).toEqual({ ok: true, errors: [], reasons: [] })
      // Fixtures must not be mistaken for production data.
      expect(Object.keys(record as object)).not.toContain('runtime')
    }
  })
})

// ── 1. Duplicate / concurrent sync ─────────────────────────────────────

describe('duplicate and concurrent sync', () => {
  it('creates exactly one candidate and no effective range', async () => {
    const source = payload([rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')])])
    const discover = discoverModels(['gpt-4o'])
    const [a, b] = await Promise.all([
      runCatalogSync({ providerId, pricePayloads: [source], discoverModels: discover, actorUserId: adminId }),
      runCatalogSync({ providerId, pricePayloads: [source], discoverModels: discover, actorUserId: adminId }),
    ])

    expect(a.failed).toBe(false)
    expect(b.failed).toBe(false)
    expect(a.candidatesCreated + b.candidatesCreated).toBe(1)
    expect(a.candidatesUnchanged + b.candidatesUnchanged).toBe(1)

    const candidates = await pool.query('SELECT count(*)::int AS n FROM price_candidates')
    expect(candidates.rows[0].n).toBe(1)
    const active = await pool.query(`SELECT count(*)::int AS n FROM provider_price_versions WHERE status = 'active'`)
    expect(active.rows[0].n).toBe(0)

    const runs = await pool.query(`SELECT count(*)::int AS n FROM sync_runs WHERE job_type = 'catalog_sync'`)
    expect(runs.rows[0].n).toBe(2)
  })

  it('a repeat sync with no semantic change only updates the check time', async () => {
    const source = payload([rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')])])
    const discover = discoverModels(['gpt-4o'])
    await runCatalogSync({ providerId, pricePayloads: [source], discoverModels: discover, actorUserId: adminId })
    const second = await runCatalogSync({
      providerId,
      pricePayloads: [source],
      discoverModels: discover,
      actorUserId: adminId,
    })
    expect(second.candidatesCreated).toBe(0)
    expect(second.candidatesUnchanged).toBe(1)
    const candidates = await pool.query('SELECT count(*)::int AS n FROM price_candidates')
    expect(candidates.rows[0].n).toBe(1)
  })
})

// ── 2. Page structure change / parse failure ───────────────────────────

describe('parse failure and page structure change', () => {
  it('keeps the active price, alerts, and never writes a zero price', async () => {
    const seeded = await syncAndApprove([rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')])], 'gpt-4o')

    const broken: PriceSourcePayload = {
      sourceType: 'parsed_page',
      url: 'https://openai.com/api/pricing',
      retrievedAt: new Date(),
      contentType: 'text/html',
      body: '<html><body><h1>New pricing layout</h1></body></html>',
      parserVersion: 'nexus-price-parser@1',
      region: 'global',
      currency: 'USD',
    }
    const parsed = parsePricePayload(broken)
    expect(parsed.ok).toBe(false)
    expect(parsed.structureChanged).toBe(true)

    const run = await runCatalogSync({
      providerId,
      pricePayloads: [broken],
      discoverModels: discoverModels(['gpt-4o']),
      actorUserId: adminId,
    })
    expect(run.failed).toBe(false)
    expect(run.parseFailures).toBe(1)
    expect(run.candidatesCreated).toBe(0)

    const active = await activeRow('gpt-4o')
    expect(active.id).toBe(seeded.versionId)
    expect(Number(active.input_price)).toBe(2.5)

    const candidates = await pool.query('SELECT count(*)::int AS n FROM price_candidates')
    expect(candidates.rows[0].n).toBe(1) // only the seeded one

    const alerts = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'catalog.price_parse_failed'`,
    )
    expect(alerts.rows[0].n).toBeGreaterThanOrEqual(1)

    const zeros = await pool.query(
      `SELECT count(*)::int AS n FROM provider_price_versions WHERE input_price = '0' AND output_price = '0'`,
    )
    expect(zeros.rows[0].n).toBe(0)
  })

  it('accepts a parsed official page that carries the structured price island', async () => {
    const record = rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')])
    const page = `<html><body><script type="application/json" data-nexus-prices>${JSON.stringify({ prices: [record] })}</script></body></html>`
    const parsed = parsePricePayload(payload([], { sourceType: 'parsed_page', body: page }))
    expect(parsed.ok).toBe(true)
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0].modelId).toBe('gpt-4o')
  })
})

// ── New model + zero-price anomaly ─────────────────────────────────────

describe('new models and zero prices', () => {
  it('a newly discovered model is pending review and not callable', async () => {
    const run = await syncPrice(
      [rec('gpt-5-new', [comp('input', '1.00'), comp('output', '4.00')])],
      ['gpt-4o', 'gpt-5-new'],
    )
    expect(run.modelsAdded).toBe(2)
    expect(run.candidatesCreated).toBe(1)
    const model = await pool.query(
      `SELECT lifecycle_status, available FROM upstream_models WHERE upstream_model_id = 'gpt-5-new'`,
    )
    expect(model.rows[0].lifecycle_status).toBe('pending_review')
    expect(model.rows[0].available).toBe(false)
    const candidate = await candidateRow(run.candidateIds[0])
    expect(candidate.status).toBe('pending_approval')
    expect(await activeRow('gpt-5-new')).toBeNull()
  })

  it('flags a zero price and never activates it', async () => {
    const run = await syncPrice([rec('gpt-4o', [comp('input', '0'), comp('output', '0')])], ['gpt-4o'])
    expect(run.candidatesCreated).toBe(1)
    expect(run.highRisk).toBe(1)
    const candidate = await candidateRow(run.candidateIds[0])
    expect(candidate.risk_reasons).toContain('zero_price_on_non_free_model')
    expect(await activeRow('gpt-4o')).toBeNull()

    const guard = canAutoActivate(
      {
        provider: 'openai',
        modelId: 'gpt-4o',
        modelIdMatched: true,
        currency: 'USD',
        components: [comp('input', '0'), comp('output', '0')],
      },
      null,
    )
    expect(guard.ok).toBe(false)
  })

  it('reports a disappeared model without touching the active version', async () => {
    const seeded = await syncAndApprove([rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')])], 'gpt-4o')
    const run = await runCatalogSync({
      providerId,
      pricePayloads: [],
      discoverModels: discoverModels([]),
      actorUserId: adminId,
    })
    expect(run.removedModels).toContain('gpt-4o')
    expect((await activeRow('gpt-4o')).id).toBe(seeded.versionId)
    const audits = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'catalog.model_removal_detected'`,
    )
    expect(audits.rows[0].n).toBe(1)
  })
})

// ── Approval RBAC ──────────────────────────────────────────────────────

describe('approval authorization', () => {
  it('denies roles without pricing:approve and leaves the candidate queued', async () => {
    const run = await syncPrice([rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')])], ['gpt-4o'])
    const developer: Principal = { kind: 'user', role: 'developer' }
    await expect(approvePriceCandidate({ candidateId: run.candidateIds[0], actor: developer })).rejects.toMatchObject({
      status: 403,
    })
    expect((await candidateRow(run.candidateIds[0])).status).toBe('pending_approval')
  })

  it('records the approver and writes an audit event', async () => {
    const run = await syncPrice([rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')])], ['gpt-4o'])
    const approved = await approvePriceCandidate({
      candidateId: run.candidateIds[0],
      actor: adminPrincipal,
      reason: 'initial price',
    })
    expect(approved.status).toBe('active')
    const version = await versionRow(approved.versionId as string)
    expect(version.approved_by).toBe(adminId)
    expect(version.approved_at).not.toBeNull()
    const audits = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'catalog.price_approved'`,
    )
    expect(audits.rows[0].n).toBe(1)
  })
})

// ── 3. Price increase ──────────────────────────────────────────────────

describe('price increase', () => {
  it('is high-risk, blocked from auto-activation, and supersede closes the old range', async () => {
    const v1 = await syncAndApprove([rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')])], 'gpt-4o')

    const run = await syncPrice([rec('gpt-4o', [comp('input', '10.00'), comp('output', '10.00')])], ['gpt-4o'])
    expect(run.candidatesCreated).toBe(1)
    expect(run.highRisk).toBe(1)

    const candidate = await candidateRow(run.candidateIds[0])
    expect(candidate.high_risk_flag).toBe(true)
    expect(candidate.risk_reasons).toContain('price_increase')
    expect(candidate.risk_reasons).toContain('price_change_exceeds_20pct')

    // Nothing changes until a human approves.
    expect((await activeRow('gpt-4o')).id).toBe(v1.versionId)

    const approved = await approvePriceCandidate({ candidateId: run.candidateIds[0], actor: adminPrincipal })
    expect(approved.status).toBe('active')
    expect(approved.autoActivateBlocked).toBe(true)
    expect(approved.riskReasons).toContain('price_change_exceeds_20pct')

    const old = await versionRow(v1.versionId)
    expect(old.status).toBe('superseded')
    expect(old.effective_to).not.toBeNull()
    // History is immutable: the superseded row still carries its original price.
    expect(Number(old.input_price)).toBe(2.5)

    const active = await activeRow('gpt-4o')
    expect(Number(active.input_price)).toBe(10)
    expect(active.id).toBe(approved.versionId)
  })
})

// ── 4. Currency change ─────────────────────────────────────────────────

describe('currency change', () => {
  it('is high-risk and never applied automatically', async () => {
    await syncAndApprove([rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')])], 'gpt-4o')

    const run = await runCatalogSync({
      providerId,
      pricePayloads: [
        payload([rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')], { currency: 'EUR' })], {
          currency: 'EUR',
        }),
      ],
      discoverModels: discoverModels(['gpt-4o']),
      actorUserId: adminId,
    })
    expect(run.candidatesCreated).toBe(1)
    const candidate = await candidateRow(run.candidateIds[0])
    expect(candidate.risk_reasons).toContain('currency_changed')
    expect(candidate.currency).toBe('EUR')

    // The active version is untouched and still USD.
    const active = await activeRow('gpt-4o')
    expect(active.currency).toBe('USD')
  })
})

// ── 5. Time-range overlap ──────────────────────────────────────────────

describe('time-range overlap', () => {
  it('refuses a backdated activation that would overlap the active range', async () => {
    const earlier = new Date(Date.now() - 30 * 86_400_000)
    const v1 = await syncAndApprove(
      [rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')], { effective_from: earlier.toISOString() })],
      'gpt-4o',
      earlier,
    )

    const older = new Date(Date.now() - 60 * 86_400_000)
    const run = await syncPrice(
      [rec('gpt-4o', [comp('input', '3.00'), comp('output', '12.00')], { effective_from: older.toISOString() })],
      ['gpt-4o'],
    )

    await expect(
      approvePriceCandidate({ candidateId: run.candidateIds[0], actor: adminPrincipal, effectiveFrom: older }),
    ).rejects.toMatchObject({ code: 'effective_range_conflict' })

    // Active range unchanged; the candidate stays safely scheduled for retry.
    const active = await activeRow('gpt-4o')
    expect(active.id).toBe(v1.versionId)
    expect((await candidateRow(run.candidateIds[0])).status).toBe('scheduled')
    const overlaps = await pool.query(
      `SELECT count(*)::int AS n FROM provider_price_versions WHERE status = 'active' AND upstream_model_id = 'gpt-4o'`,
    )
    expect(overlaps.rows[0].n).toBe(1)
  })
})

// ── 6. Scheduled activation ────────────────────────────────────────────

describe('scheduled activation', () => {
  it('publishes a signed snapshot only when the effective time arrives', async () => {
    const future = futureDate()
    const run = await syncPrice(
      [rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')], { effective_from: future.toISOString() })],
      ['gpt-4o'],
    )

    const approved = await approvePriceCandidate({
      candidateId: run.candidateIds[0],
      actor: adminPrincipal,
      effectiveFrom: future,
    })
    expect(approved.status).toBe('scheduled')
    expect((await candidateRow(run.candidateIds[0])).status).toBe('scheduled')
    expect(await activeRow('gpt-4o')).toBeNull()
    const version = await versionRow(approved.versionId as string)
    expect(version.status).toBe('approved')

    const early = await runActivationJob({ now: new Date() })
    expect(early.activated).toEqual([])
    expect(await activeRow('gpt-4o')).toBeNull()

    const due = await runActivationJob({ now: new Date(future.getTime() + 1_000) })
    expect(due.activated).toContain(run.candidateIds[0])

    const active = await activeRow('gpt-4o')
    expect(active.id).toBe(approved.versionId)
    expect(new Date(active.effective_from).toISOString()).toBe(future.toISOString())

    const snapshots = await pool.query(
      `SELECT id, sequence_number, payload, signature, signing_key_id FROM gateway_snapshots ORDER BY sequence_number DESC LIMIT 1`,
    )
    expect(snapshots.rows).toHaveLength(1)
    const snapshot = snapshots.rows[0]
    const verification = verifySnapshot({
      payload: snapshot.payload,
      signature: snapshot.signature,
      signingKeyId: snapshot.signing_key_id,
    })
    expect(verification).toEqual({ ok: true, reasons: [] })

    const tampered = { ...snapshot.payload, sequence_number: 9_999 }
    expect(
      verifySnapshot({ payload: tampered, signature: snapshot.signature, signingKeyId: snapshot.signing_key_id }).ok,
    ).toBe(false)
  })
})

// ── 7. Emergency rollback ──────────────────────────────────────────────

describe('emergency rollback', () => {
  it('creates a new version from history and never edits the historical row', async () => {
    const v1 = await syncAndApprove([rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')])], 'gpt-4o')
    const run2 = await syncPrice([rec('gpt-4o', [comp('input', '4.00'), comp('output', '12.00')])], ['gpt-4o'])
    await approvePriceCandidate({ candidateId: run2.candidateIds[0], actor: adminPrincipal })

    const v1Before = await versionRow(v1.versionId)
    const rollback = await emergencyRollback({
      providerId,
      modelId: 'gpt-4o',
      targetPriceVersionId: v1.versionId,
      actor: adminPrincipal,
      reason: 'upstream error',
    })

    expect(rollback.versionId).not.toBe(v1.versionId)
    expect(rollback.restoredFrom).toBe(v1.versionId)

    // The historical row is byte-for-byte unchanged.
    expect(await versionRow(v1.versionId)).toEqual(v1Before)
    expect((await versionRow(v1.versionId)).status).toBe('superseded')

    const active = await activeRow('gpt-4o')
    expect(active.id).toBe(rollback.versionId)
    expect(Number(active.input_price)).toBe(2.5)

    const audits = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'catalog.price_rolled_back'`,
    )
    expect(audits.rows[0].n).toBe(1)
  })
})

// ── 8. Historical recompute ────────────────────────────────────────────

describe('historical recompute', () => {
  it('re-derives a pinned version exactly, even after the catalog changes', async () => {
    const v1 = await syncAndApprove([rec('gpt-4o', [comp('input', '2.50'), comp('output', '10.00')])], 'gpt-4o')
    const pinnedComponents = await componentsFor(v1.versionId)
    const rule = {
      pricingMode: 'markup' as const,
      markupRate: '0.5',
      targetMarginRate: '0',
      fixedFee: '0',
      minimumCharge: '0',
      currency: 'USD',
    }
    const usage = { input: 1_000_000, output: 500_000, cached: 0, reasoning: 0 }

    const before = recomputeCharge({
      priceVersionId: v1.versionId,
      components: pinnedComponents,
      currency: 'USD',
      usage,
      saleRule: rule,
    })
    expect(before.roundingVersion).toBe(ROUNDING_VERSION)

    // Replace the active price (5.00 input instead of 2.50).
    const run2 = await syncPrice([rec('gpt-4o', [comp('input', '5.00'), comp('output', '20.00')])], ['gpt-4o'])
    await approvePriceCandidate({ candidateId: run2.candidateIds[0], actor: adminPrincipal })
    expect(Number((await activeRow('gpt-4o')).input_price)).toBe(5)

    const after = recomputeCharge({
      priceVersionId: v1.versionId,
      components: pinnedComponents,
      currency: 'USD',
      usage,
      saleRule: rule,
    })
    expect(after.saleCharge).toBe(before.saleCharge)
    expect(String(after.upstreamCostInCharge)).toBe(String(before.upstreamCostInCharge))
    expect(after.priceVersionId).toBe(v1.versionId)

    // The reconciled version is still resolvable from the DB.
    expect(await priceVersionIdForCandidate(v1.candidateId)).toBe(v1.versionId)
  })
})

// ── Legacy static-price isolation ──────────────────────────────────────

describe('legacy static-price isolation', () => {
  function walk(dir: string): string[] {
    return readdirSync(join(process.cwd(), dir), { recursive: true, encoding: 'utf-8' })
      .map((p) => `${dir}/${p}`.replace(/\\/g, '/'))
      .filter((p) => p.endsWith('.ts'))
  }

  it('no new catalog/pricing module imports the legacy demo-price shim', () => {
    const files = [...walk('src/lib/catalog'), ...walk('src/lib/pricing')].filter((f) => !f.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf-8')
      expect(source.includes('catalog/legacy'), `${file} must not import legacy prices`).toBe(false)
    }
    expect(existsSync(join(process.cwd(), 'src/lib/catalog/legacy.ts'))).toBe(false)
    expect(existsSync(join(process.cwd(), 'src/lib/catalog.ts'))).toBe(false)
  })

  it('the lifecycle machine forbids reactivating history', () => {
    expect(canTransition('superseded', 'active')).toBe(false)
    expect(canTransition('active', 'fetched')).toBe(false)
  })
})
