import { ConnectorError } from './connector'

export type ConnectorLifecycleState = 'pending_consent' | 'connected' | 'disconnected' | 'revoked' | 'deleted'

export interface ConnectorLifecycleRecord {
  tenant_id: string
  connector_id: string
  state: ConnectorLifecycleState
  credential_fingerprint?: string
  consented_at?: string
  disconnected_at?: string
  revoked_at?: string
  rotated_at?: string
  deleted_at?: string
}

/** In-memory contract test double: raw credentials are never retained. */
export class ConnectorLifecycle {
  private record: ConnectorLifecycleRecord

  constructor(tenantId: string, connectorId: string) {
    this.record = { tenant_id: tenantId, connector_id: connectorId, state: 'pending_consent' }
  }

  consent(fingerprint: string): ConnectorLifecycleRecord {
    this.requireState('pending_consent')
    this.record = {
      ...this.record,
      state: 'connected',
      credential_fingerprint: fingerprint,
      consented_at: new Date().toISOString(),
    }
    return this.snapshot()
  }

  disconnect(): ConnectorLifecycleRecord {
    this.requireTenant()
    if (this.record.state === 'deleted') return this.snapshot()
    this.record = {
      ...this.record,
      state: 'disconnected',
      credential_fingerprint: undefined,
      disconnected_at: new Date().toISOString(),
    }
    return this.snapshot()
  }

  revoke(): ConnectorLifecycleRecord {
    this.requireTenant()
    if (this.record.state === 'deleted') return this.snapshot()
    this.record = {
      ...this.record,
      state: 'revoked',
      credential_fingerprint: undefined,
      revoked_at: new Date().toISOString(),
    }
    return this.snapshot()
  }

  rotate(nextFingerprint: string): ConnectorLifecycleRecord {
    this.requireState('connected')
    this.record = { ...this.record, credential_fingerprint: nextFingerprint, rotated_at: new Date().toISOString() }
    return this.snapshot()
  }

  delete(): ConnectorLifecycleRecord {
    this.requireTenant()
    this.record = {
      ...this.record,
      state: 'deleted',
      credential_fingerprint: undefined,
      deleted_at: new Date().toISOString(),
    }
    return this.snapshot()
  }

  snapshot(): ConnectorLifecycleRecord {
    return { ...this.record }
  }

  private requireState(expected: ConnectorLifecycleState): void {
    if (this.record.state !== expected) {
      throw new ConnectorError(
        'permission_denied',
        this.record.tenant_id,
        `Connector lifecycle requires ${expected} state`,
      )
    }
  }

  private requireTenant(): void {
    if (!this.record.tenant_id)
      throw new ConnectorError('permission_denied', this.record.tenant_id, 'Connector tenant is required')
  }
}
