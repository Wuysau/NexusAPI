import {
  assertCanStartWork,
  ConnectorCapability,
  ConnectorError,
  ConnectorUsageEvent,
  unknownCompletion,
} from './connector'

export interface ConnectorRequest {
  tenant_id: string
  request_id: string
  model: string
  prompt: string
}

export interface ConnectorResult {
  status: 'completed' | 'unknown_completion'
  usage_event: ConnectorUsageEvent
  credential_fingerprint: string
}

export interface OwnedAccessConnector {
  readonly capability: ConnectorCapability
  execute(request: ConnectorRequest): Promise<ConnectorResult>
  disconnect(): void
  revoke(): void
}

interface MockOptions {
  tenant_id: string
  credential: string
  ambiguous?: boolean
}

function fingerprint(secret: string): string {
  let hash = 2166136261
  for (let index = 0; index < secret.length; index += 1) hash = Math.imul(hash ^ secret.charCodeAt(index), 16777619)
  return `mock-${(hash >>> 0).toString(16)}`
}

abstract class MockConnector implements OwnedAccessConnector {
  abstract readonly capability: ConnectorCapability
  private state: ConnectorCapability['revocation_state'] = 'active'
  private readonly secretFingerprint: string
  private readonly ambiguous: boolean

  protected constructor(options: MockOptions) {
    this.secretFingerprint = fingerprint(options.credential)
    this.ambiguous = options.ambiguous ?? false
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResult> {
    assertCanStartWork({ revocation_state: this.state }, request.tenant_id)
    if (request.tenant_id !== this.tenantId) {
      throw new ConnectorError(
        'permission_denied',
        request.tenant_id,
        'Connector ownership scope does not match tenant',
      )
    }
    const status = this.ambiguous ? 'unknown_completion' : 'completed'
    const event: ConnectorUsageEvent = {
      event_id: `mock-${request.request_id}`,
      tenant_id: request.tenant_id,
      connector_id: this.capability.connector_id,
      request_id: request.request_id,
      status,
      billing_mode: 'unknown',
      quota_snapshot_id: undefined,
      occurred_at: new Date().toISOString(),
    }
    if (this.ambiguous) throw unknownCompletion(request.tenant_id)
    return { status, usage_event: event, credential_fingerprint: this.secretFingerprint }
  }

  disconnect(): void {
    this.state = 'missing'
  }

  revoke(): void {
    this.state = 'revoked'
  }

  private get tenantId(): string {
    return this.capability.connector_id.split(':')[1] ?? ''
  }
}

export class MockDirectApiConnector extends MockConnector {
  readonly capability: ConnectorCapability
  constructor(options: MockOptions) {
    super(options)
    this.capability = {
      schema_version: 1,
      connector_id: `mock-direct:${options.tenant_id}`,
      version: '1.0.0',
      provider: 'mock',
      auth_mode: 'api_key',
      execution_mode: 'direct_api',
      supported_operations: ['chat', 'health'],
      required_scopes: ['chat:write'],
      credential_reference_type: 'fingerprint',
      heartbeat: { observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() },
      revocation_state: 'active',
    }
  }
}

export class MockLocalCodexConnector extends MockConnector {
  readonly capability: ConnectorCapability
  constructor(options: MockOptions) {
    super(options)
    this.capability = {
      schema_version: 1,
      connector_id: `mock-local:${options.tenant_id}`,
      version: '1.0.0',
      provider: 'openai-codex',
      auth_mode: 'native_login',
      execution_mode: 'local_sidecar',
      supported_operations: ['chat', 'health', 'quota'],
      required_scopes: ['codex:execute'],
      credential_reference_type: 'opaque_ref',
      heartbeat: { observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() },
      revocation_state: 'active',
    }
  }
}
