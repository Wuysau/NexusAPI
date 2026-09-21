// Catalog sync run: discover models + collect price CANDIDATES.
//
// A sync run never changes what the gateway charges. It fetches an allowed
// official source, records the raw evidence (url, retrieved_at, SHA-256,
// parser version, region, currency, billing conditions, evidence ref), parses
// it into candidate records, and diffs each against the currently ACTIVE
// version. Only a human approval + activation can change an active price
// (ADR-0003).
//
// Failure policy (spec §Sync Run, binding):
//   - fetch/parse failure  → keep the active version, record the failure, alert
//   - unknown unit / zero price / changed page structure → NEVER written as a
//     price version; recorded as risk on the candidate
//   - no semantic change   → update the check time only
//   - duplicate/concurrent runs → serialized per provider and deduplicated by
//     source content hash, so no conflicting candidates/effective ranges
//
// Price sources are restricted to: official structured API/JSON → official
// static doc → audited manual entry. Search engines, blogs and aggregators are
// not representable as a BillableSourceType at all.

import { pool } from '@/db'
import { logAudit } from '@/lib/audit'
import { decrypt, sha256hex } from '@/lib/crypto'
import type { PoolClient } from 'pg'
import type { AdapterContext, NormalizedModel } from '@/lib/providers/types'
import {
  componentAmount,
  parseDecimal,
  validatePriceRecord,
  type NexusPriceRecordV1,
  type PriceComponent,
} from '@/lib/pricing/components'
import { classifyRisk, transitionPriceCandidate, type ActivePriceVersionRef } from './lifecycle'
import { classifyUpstreamError, sourceRegistry, type BillableSourceType, type PriceSourcePayload } from './registry'

export const PRICE_PARSER_VERSION = 'nexus-price-parser@1'
export const SYNC_JOB_TYPE = 'catalog_sync'

const BILLABLE_SOURCE_TYPES: readonly BillableSourceType[] = [
  'official_api',
  'official_market',
  'parsed_page',
  'imported_json',
  'imported_csv',
  'manual',
]

export class SyncError extends Error {
  constructor(
    public code: 'invalid_source' | 'parse_failed' | 'provider_not_found' | 'no_credential',
    message: string,
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

export interface ParsedPriceRecord {
  modelId: string
  currency: string
  region: string
  serviceTier: string
  unit: string
  components: PriceComponent[]
  effectiveFrom: Date
  isFreeModel?: boolean
  raw: NexusPriceRecordV1 | Record<string, unknown>
}

export interface ParseResult {
  ok: boolean
  records: ParsedPriceRecord[]
  errors: string[]
  /** The source shape was not recognizable — active prices must not change. */
  structureChanged: boolean
  parserVersion: string
}

export interface ComponentChange {
  kind: string
  from: string | null
  to: string | null
  unit: string
}

export interface ComponentDiff {
  changed: boolean
  changes: ComponentChange[]
}

export interface CatalogSyncInput {
  providerId: string
  tenantId?: string | null
  credentialId?: string
  /** Plaintext credential for a one-off sync (tests / manual trigger). */
  secret?: string
  /** Raw price documents to ingest. */
  pricePayloads?: PriceSourcePayload[]
  /** Injection hook for model discovery (tests); otherwise the adapter is used. */
  discoverModels?: (ctx: AdapterContext) => Promise<NormalizedModel[]>
  /** Required for sourceType 'manual' — manual entry is audited to a person. */
  actorUserId?: string
  now?: Date
}

export interface CatalogSyncResult {
  runId: string
  providerCode: string
  modelsSeen: number
  modelsAdded: number
  candidatesCreated: number
  candidatesUnchanged: number
  highRisk: number
  parseFailures: number
  removedModels: string[]
  /** Candidate ids created by this run, in creation order (for approval/UI). */
  candidateIds: string[]
  failed: boolean
  error?: string
}

interface ProviderRow {
  id: string
  code: string
  official_base_url: string
  models_endpoint: string | null
  auth_scheme: string
}

interface ActiveVersionRow {
  id: string
  currency: string
  unit: string
  region: string
  service_tier: string
  components: PriceComponent[]
}

// ── Source validation & parsing (pure) ─────────────────────────────────

/** Allowed sources only; official types must carry a URL. */
export function assertBillableSource(payload: PriceSourcePayload): void {
  if (!BILLABLE_SOURCE_TYPES.includes(payload.sourceType)) {
    throw new SyncError('invalid_source', `price sync: source type "${payload.sourceType}" is not billable`)
  }
  if (payload.sourceType !== 'manual' && !payload.url) {
    throw new SyncError('invalid_source', `price sync: ${payload.sourceType} requires a source url`)
  }
  if (!payload.parserVersion) {
    throw new SyncError('invalid_source', 'price sync: parser version is required')
  }
}

function asRecordArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    for (const key of ['prices', 'data', 'records', 'models']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[]
    }
  }
  return []
}

const JSON_ISLAND_RE = /<script[^>]*data-nexus-prices[^>]*>([\s\S]*?)<\/script>/i

export function extractPriceJsonIsland(body: string): string | null {
  const match = JSON_ISLAND_RE.exec(body)
  return match ? match[1].trim() : null
}

/**
 * A model is free only when the SOURCE says so (a component condition
 * `{free: true}`). An all-zero price set is NOT evidence of a free model — it
 * is the zero-price anomaly and must never be auto-activated (spec §Sync Run).
 */
function isExplicitlyFree(components: readonly PriceComponent[]): boolean {
  return components.some((c) => c.conditions && (c.conditions as Record<string, unknown>).free === true)
}

function recordToParsed(
  record: NexusPriceRecordV1,
  fallbackCurrency: string,
  fallbackRegion: string,
): ParsedPriceRecord {
  return {
    modelId: record.model_id,
    currency: record.currency,
    region: fallbackRegion,
    serviceTier: 'default',
    unit: record.components[0]?.unit ?? 'per_million_tokens',
    components: record.components,
    effectiveFrom: new Date(record.effective_from),
    isFreeModel: isExplicitlyFree(record.components),
    raw: record,
  }
}

function parseJsonRecords(body: string, currency: string, region: string, errors: string[]): ParsedPriceRecord[] {
  const parsed = JSON.parse(body) as unknown
  const rows = asRecordArray(parsed)
  if (!rows.length) {
    errors.push('parse_failed: no price records found in payload')
    return []
  }
  const out: ParsedPriceRecord[] = []
  for (const row of rows) {
    const validation = validatePriceRecord(row)
    if (!validation.ok) {
      errors.push(`parse_failed: invalid price record: ${validation.errors.join('; ')}`)
      continue
    }
    out.push(recordToParsed(row as NexusPriceRecordV1, currency, region))
  }
  return out
}

/** Minimal CSV: model_id,currency,unit,effective_from,kind,amount[,conditions] */
function parseCsvRecords(body: string, region: string, errors: string[]): ParsedPriceRecord[] {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length < 2) {
    errors.push('parse_failed: csv has no data rows')
    return []
  }
  const header = lines[0].split(',').map((h) => h.trim())
  const idx = (name: string) => header.indexOf(name)
  for (const required of ['model_id', 'currency', 'unit', 'effective_from', 'kind', 'amount']) {
    if (idx(required) < 0) {
      errors.push(`parse_failed: csv missing column "${required}"`)
      return []
    }
  }
  const groups = new Map<string, ParsedPriceRecord>()
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((c) => c.trim())
    const modelId = cells[idx('model_id')]
    const currency = cells[idx('currency')]
    const unit = cells[idx('unit')]
    const effectiveFrom = cells[idx('effective_from')]
    const kind = cells[idx('kind')]
    const amount = cells[idx('amount')]
    const key = `${modelId}|${currency}|${unit}|${effectiveFrom}`
    const conditionsRaw = idx('conditions') >= 0 ? cells[idx('conditions')] : ''
    let conditions: Record<string, unknown> = {}
    if (conditionsRaw) {
      try {
        conditions = JSON.parse(conditionsRaw) as Record<string, unknown>
      } catch {
        errors.push(`parse_failed: csv row has invalid conditions json for ${modelId}`)
        continue
      }
    }
    const record: ParsedPriceRecord = groups.get(key) ?? {
      modelId,
      currency,
      region,
      serviceTier: 'default',
      unit,
      components: [] as PriceComponent[],
      effectiveFrom: new Date(effectiveFrom),
      raw: {},
    }
    record.components.push({ kind, unit, amount, conditions } as PriceComponent)
    groups.set(key, record)
  }
  for (const record of groups.values()) {
    record.isFreeModel = isExplicitlyFree(record.components)
  }
  return [...groups.values()]
}

/**
 * Parse a raw price document into candidates. Never throws on a bad document:
 * it returns ok:false so the caller keeps the active version and alerts.
 */
export function parsePricePayload(
  payload: PriceSourcePayload,
  ctx: { actorUserId?: string; now?: Date } = {},
): ParseResult {
  const parserVersion = payload.parserVersion || PRICE_PARSER_VERSION
  const errors: string[] = []
  let structureChanged = false
  try {
    assertBillableSource(payload)
    if (payload.sourceType === 'manual' && !ctx.actorUserId) {
      throw new SyncError('invalid_source', 'manual price entry requires an audited actor')
    }
  } catch (e) {
    return {
      ok: false,
      records: [],
      errors: [e instanceof Error ? e.message : 'invalid source'],
      structureChanged: false,
      parserVersion,
    }
  }

  let records: ParsedPriceRecord[] = []
  try {
    if (payload.sourceType === 'parsed_page') {
      const island = extractPriceJsonIsland(payload.body)
      if (!island) {
        structureChanged = true
        errors.push('parse_failed: page structure changed — price json island not found')
      } else {
        records = parseJsonRecords(island, payload.currency, payload.region, errors)
      }
    } else if (payload.sourceType === 'imported_csv') {
      records = parseCsvRecords(payload.body, payload.region, errors)
    } else {
      records = parseJsonRecords(payload.body, payload.currency, payload.region, errors)
    }
  } catch (e) {
    errors.push(`parse_failed: ${e instanceof Error ? e.message : 'unparseable document'}`)
  }

  return { ok: errors.length === 0 && records.length > 0, records, errors, structureChanged, parserVersion }
}

// ── Semantic diff (pure) ───────────────────────────────────────────────

function amountsEqual(a: string, b: string): boolean {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  return x.num * y.den === y.num * x.den
}

function conditionsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`
}

/** Semantic component diff: added / removed / changed kinds, order-independent. */
export function diffComponents(next: readonly PriceComponent[], prev: readonly PriceComponent[]): ComponentDiff {
  const changes: ComponentChange[] = []
  const nextByKind = new Map(next.map((c) => [c.kind, c]))
  const prevByKind = new Map(prev.map((c) => [c.kind, c]))
  for (const [kind, c] of nextByKind) {
    const before = prevByKind.get(kind)
    if (!before) changes.push({ kind, from: null, to: c.amount, unit: c.unit })
    else if (
      !amountsEqual(before.amount, c.amount) ||
      before.unit !== c.unit ||
      !conditionsEqual(before.conditions, c.conditions)
    ) {
      changes.push({ kind, from: before.amount, to: c.amount, unit: c.unit })
    }
  }
  for (const [kind, c] of prevByKind) {
    if (!nextByKind.has(kind)) changes.push({ kind, from: c.amount, to: null, unit: c.unit })
  }
  return { changed: changes.length > 0, changes }
}

// ── DB helpers ─────────────────────────────────────────────────────────

async function loadProvider(client: PoolClient, providerId: string): Promise<ProviderRow> {
  const res = await client.query<ProviderRow>(
    'SELECT id, code, official_base_url, models_endpoint, auth_scheme FROM providers WHERE id = $1',
    [providerId],
  )
  if (!res.rows.length) throw new SyncError('provider_not_found', `provider ${providerId} not found`)
  return res.rows[0]
}

async function activeVersionFor(
  client: PoolClient,
  providerId: string,
  modelId: string,
  region: string,
  serviceTier: string,
): Promise<ActiveVersionRow | null> {
  const res = await client.query<{ id: string; currency: string; unit: string; region: string; service_tier: string }>(
    `SELECT id, currency, unit, region, service_tier
     FROM provider_price_versions
     WHERE provider_id = $1 AND upstream_model_id = $2 AND region = $3 AND service_tier = $4 AND status = 'active'
     LIMIT 1`,
    [providerId, modelId, region, serviceTier],
  )
  if (!res.rows.length) return null
  const version = res.rows[0]
  const comps = await client.query<{ kind: string; unit: string; amount: string; conditions: Record<string, unknown> }>(
    'SELECT kind, unit, amount, conditions FROM price_components WHERE price_version_id = $1 ORDER BY kind',
    [version.id],
  )
  return {
    ...version,
    components: comps.rows.map((c) => ({
      kind: c.kind as PriceComponent['kind'],
      unit: c.unit,
      amount: c.amount,
      conditions: c.conditions ?? {},
    })),
  }
}

async function duplicateCandidateExists(
  client: PoolClient,
  providerId: string,
  modelId: string,
  sha256: string,
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1
     FROM price_candidates pc
     JOIN price_sources ps ON ps.id = pc.price_source_id
     WHERE pc.provider_id = $1 AND pc.upstream_model_id = $2 AND ps.content_sha256 = $3
       AND pc.status IN ('fetched','validated','pending_approval','scheduled')
     LIMIT 1`,
    [providerId, modelId, sha256],
  )
  return res.rows.length > 0
}

async function findVersionIdForCandidate(client: PoolClient, candidateId: string): Promise<string | null> {
  const res = await client.query<{ price_version_id: string }>(
    'SELECT price_version_id FROM price_components WHERE price_candidate_id = $1 LIMIT 1',
    [candidateId],
  )
  return res.rows[0]?.price_version_id ?? null
}

interface UpsertModelResult {
  seen: number
  added: number
  ids: Set<string>
}

async function upsertDiscoveredModels(
  client: PoolClient,
  providerId: string,
  models: NormalizedModel[],
): Promise<UpsertModelResult> {
  const ids = new Set(models.map((m) => m.upstreamModelId))
  let added = 0
  for (const m of models) {
    const existing = await client.query(
      'SELECT id FROM upstream_models WHERE provider_id = $1 AND upstream_model_id = $2',
      [providerId, m.upstreamModelId],
    )
    if (!existing.rows.length) {
      await client.query(
        `INSERT INTO upstream_models
           (id, provider_id, upstream_model_id, display_name, description, context_window, max_output_tokens,
            capabilities, lifecycle_status, available, manually_enabled, missing_sync_count, raw_metadata)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb, 'pending_review', false, false, 0, $8::jsonb)`,
        [
          providerId,
          m.upstreamModelId,
          m.displayName,
          m.description ?? null,
          m.contextWindow ?? null,
          m.maxOutputTokens ?? null,
          JSON.stringify(m.capabilities ?? []),
          JSON.stringify(m.rawMetadata ?? {}),
        ],
      )
      added++
    } else {
      await client.query(
        'UPDATE upstream_models SET last_seen_at = now(), missing_sync_count = 0, updated_at = now() WHERE provider_id = $1 AND upstream_model_id = $2',
        [providerId, m.upstreamModelId],
      )
    }
  }
  return { seen: models.length, added, ids }
}

// ── Sync run ───────────────────────────────────────────────────────────

async function createRun(client: PoolClient, input: CatalogSyncInput, tenantId: string | null): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO sync_runs (id, tenant_id, job_type, provider_id, status, started_at, result_summary)
     VALUES (gen_random_uuid(), $1, $2, $3, 'running', now(), '{}'::jsonb)
     RETURNING id`,
    [tenantId, SYNC_JOB_TYPE, input.providerId],
  )
  return res.rows[0].id
}

async function finishRun(
  client: PoolClient,
  runId: string,
  status: 'completed' | 'failed',
  summary: Record<string, unknown>,
  error?: string,
): Promise<void> {
  await client.query(
    `UPDATE sync_runs SET status = $2, completed_at = now(), result_summary = $3::jsonb, error_message = $4 WHERE id = $1`,
    [runId, status, JSON.stringify(summary), error ?? null],
  )
}

/**
 * Run a catalog sync. Never mutates an active price version; on any failure the
 * active catalog is left exactly as it was.
 */
export async function runCatalogSync(input: CatalogSyncInput): Promise<CatalogSyncResult> {
  const now = input.now ?? new Date()
  const tenantId = input.tenantId ?? null
  const client = await pool.connect()
  let runId = ''
  const empty: CatalogSyncResult = {
    runId: '',
    providerCode: '',
    modelsSeen: 0,
    modelsAdded: 0,
    candidatesCreated: 0,
    candidatesUnchanged: 0,
    highRisk: 0,
    parseFailures: 0,
    removedModels: [],
    candidateIds: [],
    failed: true,
  }

  try {
    await client.query('BEGIN')
    const provider = await loadProvider(client, input.providerId)
    runId = await createRun(client, input, tenantId)

    // Serialize runs per provider: duplicate/concurrent syncs queue here, and
    // the dedupe query below makes the second run a no-op.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`catalog:sync:${input.providerId}`])

    const adapter = sourceRegistry.get(provider.code)
    let secret = input.secret
    if (!secret && input.credentialId) {
      const cred = await client.query<{ encrypted_secret: string }>(
        'SELECT encrypted_secret FROM provider_credentials WHERE id = $1',
        [input.credentialId],
      )
      if (!cred.rows.length) throw new SyncError('no_credential', `credential ${input.credentialId} not found`)
      secret = decrypt(cred.rows[0].encrypted_secret)
    }
    const ctx: AdapterContext = {
      baseUrl: provider.official_base_url,
      modelsEndpoint: provider.models_endpoint ?? undefined,
      authScheme:
        provider.auth_scheme === 'x-api-key' ? 'x_api_key' : provider.auth_scheme === 'query' ? 'query' : 'bearer',
      secret: secret ?? '',
      timeoutMs: 15000,
    }

    // 1. Model discovery (network, before the row-level work below).
    let discovered: NormalizedModel[]
    if (input.discoverModels) discovered = await input.discoverModels(ctx)
    else if (adapter) discovered = await adapter.discoverModels(ctx)
    else discovered = []

    const modelResult = await upsertDiscoveredModels(client, input.providerId, discovered)

    // 2. Price collection.
    let payloads = input.pricePayloads ?? []
    if (!input.pricePayloads && adapter?.fetchPriceSource) {
      payloads = await adapter.fetchPriceSource(ctx)
    }

    const summary: Record<string, unknown> = {
      modelsSeen: modelResult.seen,
      modelsAdded: modelResult.added,
      candidatesCreated: 0,
      candidatesUnchanged: 0,
      highRisk: 0,
      parseFailures: 0,
      removedModels: [] as string[],
      parserVersion: PRICE_PARSER_VERSION,
    }
    const candidateIds: string[] = []

    for (const payload of payloads) {
      const sha256 = sha256hex(payload.body)
      const parsed = parsePricePayload(payload, { actorUserId: input.actorUserId, now })
      if (!parsed.ok) {
        summary.parseFailures = (summary.parseFailures as number) + 1
        const priorErrors = (summary.parseErrors as string[] | undefined) ?? []
        summary.parseErrors = [...priorErrors, ...parsed.errors].slice(0, 20)
        // Alert only. Active prices are untouched, and no zero price is written.
        await logAudit({
          actorUserId: input.actorUserId ?? null,
          tenantId,
          action: 'catalog.price_parse_failed',
          targetType: 'provider',
          targetId: input.providerId,
          metadata: {
            provider: provider.code,
            sourceUrl: payload.url,
            sourceType: payload.sourceType,
            sha256,
            parserVersion: parsed.parserVersion,
            structureChanged: parsed.structureChanged,
            errors: parsed.errors,
          },
          client,
        })
        continue
      }

      for (const record of parsed.records) {
        const matched = modelResult.ids.has(record.modelId)
        const active = await activeVersionFor(
          client,
          input.providerId,
          record.modelId,
          record.region,
          record.serviceTier,
        )
        const activeRef: ActivePriceVersionRef | null = active
          ? { id: active.id, currency: active.currency, components: active.components }
          : null

        const semanticDiff = active
          ? diffComponents(record.components, active.components)
          : { changed: true, changes: [] as ComponentChange[] }
        const metadataChanged = active ? active.currency !== record.currency || active.unit !== record.unit : true

        if (active && !semanticDiff.changed && !metadataChanged) {
          summary.candidatesUnchanged = (summary.candidatesUnchanged as number) + 1
          continue
        }
        if (await duplicateCandidateExists(client, input.providerId, record.modelId, sha256)) {
          summary.candidatesUnchanged = (summary.candidatesUnchanged as number) + 1
          continue
        }

        const risk = classifyRisk(
          {
            provider: provider.code,
            modelId: record.modelId,
            modelIdMatched: matched,
            currency: record.currency,
            components: record.components,
            parserStructureChanged: parsed.structureChanged,
            isFreeModel: record.isFreeModel,
          },
          activeRef,
        )

        // Evidence row: everything needed to reproduce this candidate.
        const sourceRes = await client.query<{ id: string }>(
          `INSERT INTO price_sources
             (id, provider_id, upstream_model_id, source_type, source_url, content_sha256, retrieved_at,
              parser_version, region, currency, billing_conditions, raw_evidence_ref)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            input.providerId,
            record.modelId,
            payload.sourceType,
            payload.url || null,
            sha256,
            payload.retrievedAt,
            parsed.parserVersion,
            record.region,
            record.currency,
            payload.billingConditions ?? null,
            payload.evidenceRef ?? null,
          ],
        )
        const priceSourceId = sourceRes.rows[0].id

        const candidateRes = await client.query<{ id: string }>(
          `INSERT INTO price_candidates
             (id, provider_id, upstream_model_id, price_source_id, currency, region, status,
              high_risk_flag, risk_reasons, effective_from)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'fetched', $6, $7::jsonb, $8)
           RETURNING id`,
          [
            input.providerId,
            record.modelId,
            priceSourceId,
            record.currency,
            record.region,
            risk.highRisk,
            JSON.stringify(risk.reasons),
            record.effectiveFrom,
          ],
        )
        const candidateId = candidateRes.rows[0].id
        candidateIds.push(candidateId)

        const versionRes = await client.query<{ id: string }>(
          `INSERT INTO provider_price_versions
             (id, provider_id, upstream_model_id, currency, region, service_tier, context_min, context_max,
              input_price, cached_input_price, cache_write_price, output_price, reasoning_price,
              request_price, tool_price, image_price, audio_price, unit, source_type, source_url,
              source_document_hash, fetched_at, effective_from, effective_to, status, raw_source_data)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NULL, NULL,
                   $6, $7, '0', $8, $9, $10, '0', $11, $12, $13, $14, $15, $16, $17, $18, NULL, 'pending', $19::jsonb)
           RETURNING id`,
          [
            input.providerId,
            record.modelId,
            record.currency,
            record.region,
            record.serviceTier,
            componentAmount(record.components, 'input'),
            componentAmount(record.components, 'cached_input'),
            componentAmount(record.components, 'output'),
            componentAmount(record.components, 'reasoning'),
            componentAmount(record.components, 'request'),
            componentAmount(record.components, 'image'),
            componentAmount(record.components, 'audio'),
            record.unit,
            payload.sourceType,
            payload.url || null,
            sha256,
            payload.retrievedAt,
            record.effectiveFrom,
            JSON.stringify({
              record: record.raw,
              evidenceRef: payload.evidenceRef ?? null,
              parserVersion: parsed.parserVersion,
            }),
          ],
        )
        const versionId = versionRes.rows[0].id

        for (const component of record.components) {
          await client.query(
            `INSERT INTO price_components (id, price_version_id, price_candidate_id, kind, unit, amount, conditions)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb)`,
            [
              versionId,
              candidateId,
              component.kind,
              component.unit,
              component.amount,
              JSON.stringify(component.conditions ?? {}),
            ],
          )
        }

        // Walk the lifecycle: parsed+validated → queued for approval.
        await transitionPriceCandidate({
          candidateId,
          to: 'validated',
          actorUserId: input.actorUserId ?? null,
          tenantId,
          reason: 'sync: schema validation passed',
          client,
        })
        await transitionPriceCandidate({
          candidateId,
          to: 'pending_approval',
          actorUserId: input.actorUserId ?? null,
          tenantId,
          reason: 'sync: queued for human approval',
          client,
        })

        summary.candidatesCreated = (summary.candidatesCreated as number) + 1
        if (risk.highRisk) summary.highRisk = (summary.highRisk as number) + 1
      }
    }

    // 3. Deletion detection — never auto-removes anything.
    const activeRows = await client.query<{ upstream_model_id: string }>(
      `SELECT DISTINCT upstream_model_id FROM provider_price_versions WHERE provider_id = $1 AND status = 'active'`,
      [input.providerId],
    )
    const removed = activeRows.rows.map((r) => r.upstream_model_id).filter((id) => !modelResult.ids.has(id))
    if (removed.length) {
      summary.removedModels = removed
      await logAudit({
        actorUserId: input.actorUserId ?? null,
        tenantId,
        action: 'catalog.model_removal_detected',
        targetType: 'provider',
        targetId: input.providerId,
        metadata: { provider: provider.code, removed },
        client,
      })
    }

    await finishRun(client, runId, 'completed', summary)
    await client.query('COMMIT')

    return {
      runId,
      providerCode: provider.code,
      modelsSeen: modelResult.seen,
      modelsAdded: modelResult.added,
      candidatesCreated: summary.candidatesCreated as number,
      candidatesUnchanged: summary.candidatesUnchanged as number,
      highRisk: summary.highRisk as number,
      parseFailures: summary.parseFailures as number,
      removedModels: removed,
      candidateIds,
      failed: false,
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    const message = e instanceof Error ? e.message : 'catalog sync failed'
    // Mark the run failed in a fresh statement; never touch active versions.
    if (runId) {
      await pool
        .query(`UPDATE sync_runs SET status = 'failed', completed_at = now(), error_message = $2 WHERE id = $1`, [
          runId,
          message,
        ])
        .catch(() => {})
    }
    const classification = classifyUpstreamError(e)
    await logAudit({
      actorUserId: input.actorUserId ?? null,
      tenantId,
      action: 'catalog.sync_failed',
      targetType: 'provider',
      targetId: input.providerId,
      metadata: { runId, kind: classification.kind, message },
    }).catch(() => {})
    return { ...empty, runId, failed: true, error: message }
  } finally {
    client.release()
  }
}

/** Version id created for a candidate (via its components). Exposed for tests/console. */
export async function priceVersionIdForCandidate(candidateId: string): Promise<string | null> {
  const client = await pool.connect()
  try {
    return await findVersionIdForCandidate(client, candidateId)
  } finally {
    client.release()
  }
}
