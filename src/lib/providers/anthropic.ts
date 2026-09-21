// Anthropic catalog adapter. Official endpoint:
//   GET https://api.anthropic.com/v1/models
//   headers: x-api-key, anthropic-version: 2023-06-01
// Returns paginated { data: [{ id, type, display_name }], has_more, first_id, last_id }.
// Capabilities are not declared by this endpoint; recorded as [] pending review.

import type { AdapterContext, ModelCatalogAdapter, NormalizedModel, CredentialVerificationResult } from './types'
import { UpstreamError, redact } from './openai-compatible'

interface AnthropicModelRow {
  id: string
  type?: string
  display_name?: string
  [k: string]: unknown
}

async function fetchPage(
  ctx: AdapterContext,
  afterId?: string,
): Promise<{ rows: AnthropicModelRow[]; hasMore: boolean; lastId?: string }> {
  const url = new URL(ctx.modelsEndpoint || '/v1/models', ctx.baseUrl)
  if (afterId) url.searchParams.set('after', afterId)
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'content-type': 'application/json', 'x-api-key': ctx.secret, 'anthropic-version': '2023-06-01' },
    signal: ctx.signal,
    redirect: 'error',
  })
  if (!res.ok) throw new UpstreamError(`models http ${res.status}`, res.status)
  const data = (await res.json()) as { data?: AnthropicModelRow[]; has_more?: boolean; last_id?: string }
  return { rows: Array.isArray(data.data) ? data.data : [], hasMore: !!data.has_more, lastId: data.last_id }
}

export function createAnthropicCatalog(ctx: AdapterContext): ModelCatalogAdapter {
  return {
    async listModels(): Promise<NormalizedModel[]> {
      const models: NormalizedModel[] = []
      const seen = new Set<string>()
      let afterId: string | undefined
      // Cap pagination to avoid runaway loops.
      for (let page = 0; page < 50; page++) {
        const { rows, hasMore, lastId } = await fetchPage(ctx, afterId)
        for (const row of rows) {
          if (!row?.id || seen.has(row.id)) continue
          seen.add(row.id)
          models.push({
            upstreamModelId: row.id,
            displayName: row.display_name || row.id,
            capabilities: [],
            lifecycle: 'pending_review',
            rawMetadata: { type: row.type },
          })
        }
        if (!hasMore || !lastId) break
        afterId = lastId
      }
      return models
    },
    async verifyCredential(): Promise<CredentialVerificationResult> {
      try {
        await fetchPage(ctx)
        return { ok: true, verifiedAt: new Date().toISOString() }
      } catch (e) {
        return { ok: false, errorCode: 'verify_failed', errorMessage: redact(e), verifiedAt: new Date().toISOString() }
      }
    },
  }
}
