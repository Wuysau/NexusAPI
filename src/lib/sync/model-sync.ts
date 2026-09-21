// Model sync orchestration. Fetches the live model list from a provider via
// its catalog adapter and reconciles `upstream_models`.
//
// Rules (spec §5):
//   - New models → lifecycle pending_review, not callable until approved.
//   - Disappeared models → increment missing_sync_count; retire only after
//     the threshold (default 3). Never delete (preserves billing links).
//   - Sync failure must NOT clear or remove existing models.
//   - Sync never modifies prices (separate flow).
//   - Records the run in background_jobs.

import { db } from '@/db'
import { upstreamModels, providers, providerCredentials, backgroundJobs } from '@/db/schema'
import { eq, and, inArray, sql } from 'drizzle-orm'
import { createCatalog } from '@/lib/providers/registry'
import { decrypt } from '@/lib/crypto'
import type { AdapterContext } from '@/lib/providers/types'
import type { NormalizedModel } from '@/lib/providers/types'

export const MISSING_THRESHOLD = 3

export interface SyncResult {
  providerCode: string
  added: number
  updated: number
  unchanged: number
  missing: number // incremented missing_sync_count this run
  retired: number // crossed threshold → retired
  failed: boolean
  error?: string
}

export interface SyncInput {
  providerId: string
  credentialId: string
  /** Override the threshold (tests). */
  missingThreshold?: number
}

export async function syncProviderModels(input: SyncInput): Promise<SyncResult> {
  const threshold = input.missingThreshold ?? MISSING_THRESHOLD
  const job = await db
    .insert(backgroundJobs)
    .values({
      type: 'model_sync',
      status: 'running',
      payload: { providerId: input.providerId, credentialId: input.credentialId },
      startedAt: new Date(),
    })
    .returning({ id: backgroundJobs.id })
  const jobId = job[0].id

  try {
    const prov = await db.select().from(providers).where(eq(providers.id, input.providerId)).limit(1)
    if (!prov[0]) throw new Error('provider not found')
    const cred = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.id, input.credentialId))
      .limit(1)
    if (!cred[0]) throw new Error('credential not found')
    const provider = prov[0]
    const credential = cred[0]

    const ctx: AdapterContext = {
      baseUrl: provider.officialBaseUrl,
      modelsEndpoint: provider.modelsEndpoint ?? undefined,
      authScheme:
        provider.authScheme === 'x-api-key' ? 'x_api_key' : provider.authScheme === 'query' ? 'query' : 'bearer',
      secret: decrypt(credential.encryptedSecret),
      timeoutMs: 15000,
    }
    const adapter = createCatalog(provider.code, ctx)
    const remote = await adapter.listModels()

    const result = await reconcileModels({
      providerId: input.providerId,
      remote,
      threshold,
    })

    await db
      .update(backgroundJobs)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(backgroundJobs.id, jobId))
    return { providerCode: provider.code, ...result, failed: false }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'sync failed'
    await db
      .update(backgroundJobs)
      .set({ status: 'failed', lastError: msg, completedAt: new Date() })
      .where(eq(backgroundJobs.id, jobId))
    // Do NOT touch existing models on failure.
    return { providerCode: '', added: 0, updated: 0, unchanged: 0, missing: 0, retired: 0, failed: true, error: msg }
  }
}

interface ReconcileArgs {
  providerId: string
  remote: NormalizedModel[]
  threshold: number
}

async function reconcileModels(args: ReconcileArgs): Promise<Omit<SyncResult, 'providerCode' | 'failed' | 'error'>> {
  const { providerId, remote, threshold } = args
  const remoteIds = new Set(remote.map((m) => m.upstreamModelId))
  const existing = await db.select().from(upstreamModels).where(eq(upstreamModels.providerId, providerId))

  let added = 0,
    updated = 0,
    unchanged = 0,
    missing = 0,
    retired = 0

  // Upsert remote models.
  for (const m of remote) {
    const row = existing.find((e) => e.upstreamModelId === m.upstreamModelId)
    if (!row) {
      // New model → pending review, not callable yet.
      await db.insert(upstreamModels).values({
        providerId,
        upstreamModelId: m.upstreamModelId,
        displayName: m.displayName,
        description: m.description ?? null,
        contextWindow: m.contextWindow ?? null,
        maxOutputTokens: m.maxOutputTokens ?? null,
        capabilities: m.capabilities,
        lifecycleStatus: 'pending_review',
        available: false,
        manuallyEnabled: false,
        missingSyncCount: 0,
        rawMetadata: m.rawMetadata ?? {},
      })
      added++
    } else {
      const changed =
        row.displayName !== m.displayName ||
        (m.contextWindow != null && row.contextWindow !== m.contextWindow) ||
        JSON.stringify(row.capabilities) !== JSON.stringify(m.capabilities)
      if (changed) {
        await db
          .update(upstreamModels)
          .set({
            displayName: m.displayName,
            description: m.description ?? row.description,
            contextWindow: m.contextWindow ?? row.contextWindow,
            maxOutputTokens: m.maxOutputTokens ?? row.maxOutputTokens,
            capabilities: m.capabilities,
            rawMetadata: m.rawMetadata ?? row.rawMetadata,
            lastSeenAt: new Date(),
            missingSyncCount: 0,
            updatedAt: new Date(),
          })
          .where(eq(upstreamModels.id, row.id))
        updated++
      } else {
        await db
          .update(upstreamModels)
          .set({ lastSeenAt: new Date(), missingSyncCount: 0, updatedAt: new Date() })
          .where(eq(upstreamModels.id, row.id))
        unchanged++
      }
    }
  }

  // Mark missing models.
  const missingRows = existing.filter((e) => !remoteIds.has(e.upstreamModelId))
  for (const row of missingRows) {
    const count = row.missingSyncCount + 1
    if (count >= threshold) {
      await db
        .update(upstreamModels)
        .set({ missingSyncCount: count, available: false, lifecycleStatus: 'retired', updatedAt: new Date() })
        .where(eq(upstreamModels.id, row.id))
      retired++
    } else {
      await db
        .update(upstreamModels)
        .set({ missingSyncCount: count, updatedAt: new Date() })
        .where(eq(upstreamModels.id, row.id))
    }
    missing++
  }

  return { added, updated, unchanged, missing, retired }
}
