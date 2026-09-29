import { createHash } from 'node:crypto'
import { buildSnapshotPayload, canonicalJson } from '@/lib/catalog/snapshot'

/** Already scope-validated channel configuration; never contains plaintext credentials. */
export interface LocalSnapshotChannel {
  transport?: string
  project_id?: string
  tenant_id?: string | null
  id: string
  provider_id: string
  provider: string
  protocol?: string
  base_url: string
  auth_scheme: string
  models: string[]
  region: string
  data_residency: string
  credential_mode: string
  credential_ref: string
  credential_version?: number
  credential_fingerprint: string
  connection_id: string | null
  weight: number
  priority: number
  capabilities: string[]
  enabled: boolean
}

/** A local configuration revision is not an official catalog or price publication. */
export function buildLocalSnapshot(tenantId: string | null, input: LocalSnapshotChannel[], generatedAt = new Date()) {
  const channels = input
    .filter((c) => tenantId !== null && c.tenant_id === tenantId && c.enabled && c.credential_mode === 'byok')
    .map(({ tenant_id: _tenantId, ...c }) => {
      if (
        !c.connection_id ||
        !c.credential_ref ||
        !Number.isSafeInteger(c.credential_version) ||
        c.credential_version! < 1
      )
        throw new Error('Local channel requires an active bound credential and connection')
      // Only the configured chat transport capabilities are represented. No
      // inference of vision, context limits or official vendor certification.
      const capabilities = c.capabilities.filter((v) => v === 'text' || v === 'streaming')
      // The console persists "chat"; both configured protocol adapters support
      // text chat and SSE transport. Other capabilities remain unproven.
      if (c.capabilities.includes('chat') && (c.protocol === 'openai' || c.protocol === 'anthropic'))
        capabilities.push('text', 'streaming')
      return {
        ...c,
        ...(c.transport === 'local_sidecar' ? { tenant_id: tenantId } : {}),
        models: [...c.models].sort(),
        capabilities: [...new Set(capabilities)].sort(),
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  const models = channels
    .flatMap((c) =>
      c.models.map((id) => ({
        id,
        provider: c.provider,
        aliases: [] as string[],
        capabilities: c.capabilities,
        context_window: 0,
        max_output_tokens: 0,
        license: 'customer-configured-owned-access',
        status: 'active',
        display_name: id,
      })),
    )
    .filter((model, index, all) => all.findIndex((m) => m.id === model.id && m.provider === model.provider) === index)
    .sort((a, b) => a.id.localeCompare(b.id) || a.provider.localeCompare(b.provider))
  const checksum = createHash('sha256')
    .update(canonicalJson({ tenant_id: tenantId, channels, models }))
    .digest('hex')
  return {
    channels,
    models,
    payload: buildSnapshotPayload({
      tenantId,
      sequenceNumber: 1,
      catalogVersion: { id: `local-${checksum}`, version: 1, checksum },
      priceVersions: [],
      routingPolicies: [],
      generatedAt,
    }),
  }
}
