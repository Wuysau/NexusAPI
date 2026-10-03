import { pool } from '@/db'
import type { LocalSnapshotChannel } from '@/lib/channels/local-snapshot'
import { connectorChatCapabilitySQL, modelIDs } from './control'

export async function connectorChannels(tenantId: string | null): Promise<LocalSnapshotChannel[]> {
  if (!tenantId || process.env.NEXUS_CONNECTORS_ENABLED !== 'true') return []
  const result = await pool.query(
    `SELECT ch.id,ch.provider_id,ch.provider_credential_id,ch.name,ch.weight,ch.priority,ch.metadata,
    c.id connection_id,c.project_id,pc.fingerprint FROM channels ch
    JOIN providers p ON p.id=ch.provider_id AND p.code='ollama' AND p.enabled=true
    JOIN provider_credentials pc ON pc.id=ch.provider_credential_id AND pc.tenant_id=ch.tenant_id AND pc.provider_id=ch.provider_id AND pc.enabled=true
    JOIN owned_connections c ON c.id=ch.metadata->>'connection_id' AND c.tenant_id=ch.tenant_id
    JOIN projects project ON project.id=c.project_id AND project.tenant_id=c.tenant_id AND project.organization_id=pc.organization_id
    WHERE ch.tenant_id=$1 AND ch.enabled=true AND ch.metadata->>'transport'='local_sidecar'
    AND ${connectorChatCapabilitySQL}
    AND c.mode='local_sidecar' AND c.revoked_at IS NULL AND project.status='active' AND project.archived_at IS NULL`,
    [tenantId],
  )
  return result.rows.map((row) => ({
    tenant_id: tenantId,
    id: row.id,
    provider_id: row.provider_id,
    provider: 'ollama',
    protocol: 'openai',
    base_url: 'https://connector.invalid/v1',
    auth_scheme: 'bearer',
    models: modelIDs(row.metadata.models),
    region: 'local',
    data_residency: 'local',
    credential_mode: 'byok',
    credential_ref: row.provider_credential_id,
    credential_version: 1,
    credential_fingerprint: row.fingerprint,
    connection_id: row.connection_id,
    project_id: row.project_id,
    transport: 'local_sidecar',
    weight: row.weight,
    priority: row.priority,
    capabilities: ['text', 'streaming'],
    enabled: true,
  }))
}
