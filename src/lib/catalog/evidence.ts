import type { PoolClient } from 'pg'

/** Explicit seed markers only: unfamiliar providers/models are not demo evidence. */
export function isDemoModel(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.demo === true
}

/** RFC-reserved .invalid hosts cannot be provider pricing evidence. */
export function isPlaceholderPriceSource(sourceUrl: string | null | undefined): boolean {
  if (!sourceUrl) return false
  try {
    const hostname = new URL(sourceUrl).hostname.toLowerCase().replace(/\.$/, '')
    return hostname === 'invalid' || hostname.endsWith('.invalid')
  } catch {
    return false
  }
}

export class PriceEvidenceError extends Error {
  readonly code = 'placeholder_price_evidence'
  constructor() {
    super('演示价格来源不能批准或生效，请提交真实来源的价格候选。')
    this.name = 'PriceEvidenceError'
  }
}

/** Called after locking the candidate, before price/lifecycle writes. */
export async function assertCandidatePriceEvidence(client: PoolClient, candidateId: string): Promise<void> {
  const sources = await client.query<{ source_url: string | null }>(
    `SELECT s.source_url FROM price_sources s
     JOIN price_candidates c ON c.price_source_id = s.id WHERE c.id = $1 FOR SHARE OF s`,
    [candidateId],
  )
  const versions = await client.query<{ source_url: string | null }>(
    `SELECT v.source_url FROM provider_price_versions v
     JOIN price_components pc ON pc.price_version_id = v.id WHERE pc.price_candidate_id = $1 FOR SHARE OF v`,
    [candidateId],
  )
  if ([...sources.rows, ...versions.rows].some((row) => isPlaceholderPriceSource(row.source_url))) {
    throw new PriceEvidenceError()
  }
}
