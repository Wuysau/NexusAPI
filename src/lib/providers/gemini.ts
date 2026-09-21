// Google Gemini catalog adapter. Official endpoint:
//   GET https://generativelanguage.googleapis.com/v1beta/models?key={secret}
// Returns { models: [{ name: "models/<id>", displayName, inputTokenLimit,
//   outputTokenLimit, supportedGenerationMethods: [...] }] }.
//
// Capabilities are derivable from supportedGenerationMethods only in part
// (generateContent → text, streamGenerateContent → streaming). We record
// those two conservatively and leave the rest for admin review. No guessing
// from model names.

import type {
  AdapterContext,
  ModelCatalogAdapter,
  NormalizedModel,
  CredentialVerificationResult,
  Capability,
} from './types'
import { UpstreamError, redact } from './openai-compatible'

interface GeminiModelRow {
  name: string // "models/gemini-2.5-flash"
  displayName?: string
  description?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
  supportedGenerationMethods?: string[]
}

export function createGeminiCatalog(ctx: AdapterContext): ModelCatalogAdapter {
  const base = ctx.baseUrl.replace(/\/$/, '')
  return {
    async listModels(): Promise<NormalizedModel[]> {
      const url = new URL(`${base}${ctx.modelsEndpoint || '/v1beta/models'}`)
      url.searchParams.set('key', ctx.secret)
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        signal: ctx.signal,
        redirect: 'error',
      })
      if (!res.ok) throw new UpstreamError(`models http ${res.status}`, res.status)
      const data = (await res.json()) as { models?: GeminiModelRow[] }
      const rows = Array.isArray(data.models) ? data.models : []
      const seen = new Set<string>()
      const models: NormalizedModel[] = []
      for (const row of rows) {
        const id = row.name?.replace(/^models\//, '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        const methods = new Set(row.supportedGenerationMethods || [])
        const caps: Capability[] = []
        if (methods.has('generateContent') || methods.has('streamGenerateContent')) caps.push('text')
        if (methods.has('streamGenerateContent')) caps.push('streaming')
        models.push({
          upstreamModelId: id,
          displayName: row.displayName || id,
          description: row.description,
          contextWindow: row.inputTokenLimit,
          maxOutputTokens: row.outputTokenLimit,
          capabilities: caps,
          lifecycle: 'pending_review',
          rawMetadata: { supportedGenerationMethods: row.supportedGenerationMethods },
        })
      }
      return models
    },
    async verifyCredential(): Promise<CredentialVerificationResult> {
      try {
        const url = new URL(`${base}${ctx.modelsEndpoint || '/v1beta/models'}`)
        url.searchParams.set('key', ctx.secret)
        url.searchParams.set('pageSize', '1')
        const res = await fetch(url, { method: 'GET', signal: ctx.signal, redirect: 'error' })
        if (!res.ok) throw new UpstreamError(`verify http ${res.status}`, res.status)
        return { ok: true, verifiedAt: new Date().toISOString() }
      } catch (e) {
        return { ok: false, errorCode: 'verify_failed', errorMessage: redact(e), verifiedAt: new Date().toISOString() }
      }
    },
  }
}
