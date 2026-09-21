// Model alias resolution. A platform alias ("fast-chat") can map to multiple
// providers; resolution picks the highest-priority enabled, in-effect mapping
// whose provider+model is currently available. The resolved REAL upstream model
// id is what gets persisted on the request (never just the alias).

import { db } from '@/db'
import { modelAliases, upstreamModels, providers } from '@/db/schema'
import { and, eq, desc } from 'drizzle-orm'

export interface ResolvedModel {
  alias: string
  providerId: string
  providerCode: string
  upstreamModelId: string // real upstream id, persisted on the request
  upstreamModelRowId: string // upstream_models.id
  displayName: string
  contextWindow: number | null
  maxOutputTokens: number | null
  capabilities: string[]
}

export interface AliasResolutionOptions {
  /** Restrict to a specific provider code (e.g. BYOK org only has one provider). */
  restrictToProviderCode?: string
  /** Only return models that are review-approved & enabled for calling. */
  requireAvailable?: boolean
}

/**
 * Resolve a client-supplied model name. The name may be either a platform
 * alias or a raw upstream model id. Returns null if nothing eligible.
 */
export async function resolveModel(
  requested: string,
  opts: AliasResolutionOptions = {},
): Promise<ResolvedModel | null> {
  const now = new Date()
  const requireAvailable = opts.requireAvailable ?? true

  // Try alias path first.
  const aliasRows = await db
    .select({
      a: modelAliases,
      p: providers,
    })
    .from(modelAliases)
    .innerJoin(providers, eq(modelAliases.providerId, providers.id))
    .where(and(eq(modelAliases.alias, requested), eq(modelAliases.enabled, true), eq(providers.enabled, true)))
    .orderBy(desc(modelAliases.priority))

  for (const row of aliasRows) {
    if (opts.restrictToProviderCode && row.p.code !== opts.restrictToProviderCode) continue
    if (row.a.effectiveFrom && row.a.effectiveFrom > now) continue
    if (row.a.effectiveTo && row.a.effectiveTo < now) continue

    const model = await db
      .select()
      .from(upstreamModels)
      .where(and(eq(upstreamModels.providerId, row.p.id), eq(upstreamModels.upstreamModelId, row.a.upstreamModelId)))
      .limit(1)
    const m = model[0]
    if (!m) continue
    if (requireAvailable && !(m.available && m.manuallyEnabled)) continue

    return {
      alias: requested,
      providerId: row.p.id,
      providerCode: row.p.code,
      upstreamModelId: m.upstreamModelId,
      upstreamModelRowId: m.id,
      displayName: m.displayName,
      contextWindow: m.contextWindow ?? null,
      maxOutputTokens: m.maxOutputTokens ?? null,
      capabilities: m.capabilities,
    }
  }

  // Fallback: treat `requested` as a raw upstream model id across providers.
  const direct = await db
    .select({ m: upstreamModels, p: providers })
    .from(upstreamModels)
    .innerJoin(providers, eq(upstreamModels.providerId, providers.id))
    .where(and(eq(upstreamModels.upstreamModelId, requested), eq(providers.enabled, true)))
  for (const row of direct) {
    if (opts.restrictToProviderCode && row.p.code !== opts.restrictToProviderCode) continue
    const m = row.m
    if (requireAvailable && !(m.available && m.manuallyEnabled)) continue
    return {
      alias: requested,
      providerId: row.p.id,
      providerCode: row.p.code,
      upstreamModelId: m.upstreamModelId,
      upstreamModelRowId: m.id,
      displayName: m.displayName,
      contextWindow: m.contextWindow ?? null,
      maxOutputTokens: m.maxOutputTokens ?? null,
      capabilities: m.capabilities,
    }
  }
  return null
}

/** List aliases visible for selection (admin review UI). */
export async function listAliases(): Promise<(typeof modelAliases.$inferSelect)[]> {
  return db.select().from(modelAliases).orderBy(modelAliases.alias, desc(modelAliases.priority))
}
