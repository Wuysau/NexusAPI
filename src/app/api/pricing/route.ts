// Price candidate review queue: source evidence, semantic diff against the
// active version, risk reasons, and approve/reject.
//
// Approval is capability-gated (`pricing:approve`) AND requires a fresh
// session — see `requireHighRiskContext`. The heavy lifting (lifecycle
// transition, activation, audit) stays in src/lib/catalog/{approval,lifecycle}.ts.

import { pool } from '@/db'
import { isPlaceholderPriceSource, PriceEvidenceError } from '@/lib/catalog/evidence'
import { approvePriceCandidate } from '@/lib/catalog/approval'
import { transitionPriceCandidate, LifecycleError } from '@/lib/catalog/lifecycle'
import { diffComponents } from '@/lib/catalog/sync'
import type { PriceComponent } from '@/lib/pricing/components'
import {
  apiError,
  clientIp,
  jsonOk,
  readJsonBody,
  requireContext,
  requireHighRiskContext,
  routeError,
} from '../_lib/control-plane'

export const dynamic = 'force-dynamic'

interface CandidateRow {
  id: string
  provider_id: string
  provider_code: string
  provider_name: string
  upstream_model_id: string
  currency: string
  region: string
  status: string
  high_risk_flag: boolean
  risk_reasons: string[]
  approved_by: string | null
  approved_at: Date | null
  effective_from: Date | null
  created_at: Date
  updated_at: Date
  source_type: string | null
  source_url: string | null
  version_source_urls: (string | null)[]
  content_sha256: string | null
  retrieved_at: Date | null
  parser_version: string | null
  raw_evidence_ref: string | null
}

interface ComponentRow {
  source_url?: string | null
  price_candidate_id: string | null
  kind: string
  unit: string
  amount: string
  conditions: Record<string, unknown>
}

const CANDIDATES_SQL = `
  SELECT c.id, c.provider_id, p.code AS provider_code, p.name AS provider_name,
         c.upstream_model_id, c.currency, c.region, c.status, c.high_risk_flag, c.risk_reasons,
         c.approved_by, c.approved_at, c.effective_from, c.created_at, c.updated_at,
         s.source_type, s.source_url, s.content_sha256, s.retrieved_at, s.parser_version, s.raw_evidence_ref,
         ARRAY(SELECT DISTINCT v.source_url FROM price_components pc
               JOIN provider_price_versions v ON v.id = pc.price_version_id
               WHERE pc.price_candidate_id = c.id) AS version_source_urls
    FROM price_candidates c
    JOIN providers p ON p.id = c.provider_id
    LEFT JOIN price_sources s ON s.id = c.price_source_id
   WHERE c.status IN ('fetched','validated','pending_approval','scheduled')
   ORDER BY c.high_risk_flag DESC, c.created_at DESC
   LIMIT 200`

function toComponents(rows: ComponentRow[]): PriceComponent[] {
  return rows.map((c) => ({
    kind: c.kind as PriceComponent['kind'],
    unit: c.unit,
    amount: c.amount,
    conditions: c.conditions ?? {},
  }))
}

export async function GET(req: Request) {
  try {
    await requireContext(req, 'pricing:read')
    const result = await pool.query<CandidateRow>(CANDIDATES_SQL)
    const ids = result.rows.map((r) => r.id)

    const candidateComponents = ids.length
      ? await pool.query<ComponentRow>(
          'SELECT price_candidate_id, kind, unit, amount, conditions FROM price_components WHERE price_candidate_id = ANY($1::text[]) ORDER BY kind',
          [ids],
        )
      : { rows: [] as ComponentRow[] }

    const grouped = new Map<string, ComponentRow[]>()
    for (const row of candidateComponents.rows) {
      if (!row.price_candidate_id) continue
      const list = grouped.get(row.price_candidate_id) ?? []
      list.push(row)
      grouped.set(row.price_candidate_id, list)
    }

    const candidates = []
    for (const row of result.rows) {
      const demo = [row.source_url, ...(row.version_source_urls ?? [])].some(isPlaceholderPriceSource)
      const next = toComponents(grouped.get(row.id) ?? [])
      // The currently active version for the same (provider, model, region)
      // gives the approver a true semantic diff rather than raw numbers.
      const active = await pool.query<ComponentRow>(
        `SELECT NULL::text AS price_candidate_id, pc.kind, pc.unit, pc.amount, pc.conditions, v.source_url
           FROM price_components pc
           JOIN provider_price_versions v ON v.id = pc.price_version_id
          WHERE v.provider_id = $1 AND v.upstream_model_id = $2 AND v.region = $3 AND v.status = 'active'`,
        [row.provider_id, row.upstream_model_id, row.region],
      )
      candidates.push({
        id: row.id,
        provider: { id: row.provider_id, code: row.provider_code, name: row.provider_name },
        upstreamModelId: row.upstream_model_id,
        currency: row.currency,
        region: row.region,
        status: row.status,
        approvalBlocked: demo,
        baselineEvidence: active.rows.some((price) => isPlaceholderPriceSource(price.source_url))
          ? 'demo_excluded'
          : active.rows.length
            ? 'active_version'
            : 'unknown',
        highRisk: row.high_risk_flag,
        riskReasons: row.risk_reasons ?? [],
        approvedBy: row.approved_by,
        approvedAt: row.approved_at?.toISOString() ?? null,
        effectiveFrom: row.effective_from?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        evidence: {
          kind: demo ? 'demo' : row.source_url ? 'source_record' : 'unknown',
          sourceType: row.source_type,
          sourceUrl: row.source_url,
          contentSha256: row.content_sha256,
          retrievedAt: row.retrieved_at?.toISOString() ?? null,
          parserVersion: row.parser_version,
          rawEvidenceRef: row.raw_evidence_ref,
        },
        components: next,
        diff: diffComponents(
          next,
          toComponents(active.rows.filter((price) => !isPlaceholderPriceSource(price.source_url))),
        ),
      })
    }
    return jsonOk({ candidates })
  } catch (error) {
    return routeError(error)
  }
}

interface DecisionBody {
  candidateId?: unknown
  action?: unknown
  effectiveFrom?: unknown
  reason?: unknown
}

export async function POST(req: Request) {
  try {
    // Price changes are high-risk: fresh session + pricing:approve.
    const ctx = await requireHighRiskContext(req, 'pricing:approve')
    const body = await readJsonBody<DecisionBody>(req)
    const candidateId = typeof body?.candidateId === 'string' ? body.candidateId : ''
    if (!candidateId) return apiError(400, 'invalid_request', '缺少 candidateId')
    const action = body?.action === 'reject' ? 'reject' : 'approve'
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : undefined

    try {
      if (action === 'reject') {
        const result = await transitionPriceCandidate({
          candidateId,
          to: 'rejected',
          actorUserId: ctx.principal.userId ?? null,
          tenantId: ctx.tenantId,
          reason: reason ?? 'rejected from console',
        })
        return jsonOk({ candidateId, status: 'rejected', from: result.from })
      }

      let effectiveFrom: Date | undefined
      if (typeof body?.effectiveFrom === 'string' && body.effectiveFrom) {
        const parsed = new Date(body.effectiveFrom)
        if (Number.isNaN(parsed.getTime())) return apiError(400, 'invalid_request', '生效时间格式无效')
        effectiveFrom = parsed
      }
      const evidence = await pool.query<{ source_url: string | null }>(
        `SELECT s.source_url FROM price_candidates c
         LEFT JOIN price_sources s ON s.id = c.price_source_id WHERE c.id = $1
         UNION ALL
         SELECT v.source_url FROM price_components pc
         JOIN provider_price_versions v ON v.id = pc.price_version_id WHERE pc.price_candidate_id = $1`,
        [candidateId],
      )
      if (evidence.rows.some((row) => isPlaceholderPriceSource(row.source_url))) {
        return apiError(409, 'placeholder_price_evidence', '演示价格来源不能批准或生效，请提交真实来源的价格候选。')
      }
      const result = await approvePriceCandidate({
        candidateId,
        actor: ctx.principal,
        effectiveFrom,
        reason,
        tenantId: ctx.tenantId,
        ip: clientIp(req),
      })
      return jsonOk({
        candidateId: result.candidateId,
        status: result.status,
        versionId: result.versionId,
        effectiveFrom: result.effectiveFrom,
        autoActivateBlocked: result.autoActivateBlocked,
        riskReasons: result.riskReasons,
      })
    } catch (error) {
      if (error instanceof PriceEvidenceError) {
        return apiError(409, error.code, error.message)
      }
      if (error instanceof LifecycleError) {
        return apiError(error.code === 'not_found' ? 404 : 409, error.code, error.message)
      }
      throw error
    }
  } catch (error) {
    return routeError(error)
  }
}
