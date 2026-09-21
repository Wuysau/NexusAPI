// OpenAI-compatible provider catalog adapter. Used by openai, deepseek, and
// qwen (阿里云百炼 compatible-mode), all of which expose GET {base}/v1/models
// with a Bearer token returning { data: [{ id, ... }] }.
//
// The official models endpoint returns existence only — no prices, no
// capabilities. We record capabilities as [] and lifecycle as pending_review;
// an admin fills capabilities during model review. We never guess.

import type { AdapterContext, ModelCatalogAdapter, NormalizedModel, CredentialVerificationResult } from './types'

interface OpenAiModelRow {
  id: string
  created?: number
  owned_by?: string
  [k: string]: unknown
}

async function fetchModels(ctx: AdapterContext): Promise<OpenAiModelRow[]> {
  const url = new URL(ctx.modelsEndpoint || '/v1/models', ctx.baseUrl)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (ctx.authScheme === 'bearer') headers['authorization'] = `Bearer ${ctx.secret}`
  else if (ctx.authScheme === 'x_api_key') {
    headers['x-api-key'] = ctx.secret
  }
  const res = await fetch(url, { method: 'GET', headers, signal: ctx.signal, redirect: 'error' })
  if (!res.ok) throw new UpstreamError(`models http ${res.status}`, res.status)
  const data = (await res.json()) as { data?: OpenAiModelRow[] }
  return Array.isArray(data.data) ? data.data : []
}

export function createOpenAiCompatibleCatalog(ctx: AdapterContext): ModelCatalogAdapter {
  return {
    async listModels(): Promise<NormalizedModel[]> {
      const rows = await fetchModels(ctx)
      const seen = new Set<string>()
      const models: NormalizedModel[] = []
      for (const row of rows) {
        if (!row?.id || seen.has(row.id)) continue
        seen.add(row.id)
        models.push({
          upstreamModelId: row.id,
          displayName: row.id,
          capabilities: [],
          lifecycle: 'pending_review',
          rawMetadata: { created: row.created, owned_by: row.owned_by },
        })
      }
      return models
    },
    async verifyCredential(): Promise<CredentialVerificationResult> {
      try {
        await fetchModels(ctx)
        return { ok: true, verifiedAt: new Date().toISOString() }
      } catch (e) {
        return { ok: false, errorCode: 'verify_failed', errorMessage: redact(e), verifiedAt: new Date().toISOString() }
      }
    },
  }
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

/** Never leak upstream response bodies or internal details to users. */
export function redact(e: unknown): string {
  if (e instanceof UpstreamError) return `upstream error (status ${e.status})`
  return 'upstream error'
}
