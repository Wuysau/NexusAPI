// Provider source-adapter registry (source plane).
//
// Discovery and price collection are provider-specific, but the sync core is
// not: it looks an adapter up by provider code and calls the same interface.
// Adding a provider means registering an adapter here (or at runtime) — never
// editing src/lib/catalog/sync.ts.
//
// Relationship to docs/contracts/provider-adapter.md (ProviderAdapterV1): this
// registry implements the SOURCE half of that contract — discoverModels,
// validateCredential, capabilities, classifyError, health, plus an optional
// official price source. The EXECUTION half (buildRequest, stream, parseUsage)
// belongs to the gateway data plane (Work Item E) and is deliberately not
// implemented here: the control plane never proxies provider traffic.
//
// Contract rules carried over: adapter version is observable; adapters never
// log secrets or content; adapters do NOT auto-retry — retry/backoff is decided
// by the core from `classifyError`.

import type { AdapterContext, Capability, NormalizedModel } from '@/lib/providers/types'
import { createOpenAiCompatibleCatalog } from '@/lib/providers/openai-compatible'
import { createAnthropicCatalog } from '@/lib/providers/anthropic'
import { createGeminiCatalog } from '@/lib/providers/gemini'
import { UpstreamError } from '@/lib/providers/openai-compatible'

export type CanonicalError =
  'auth' | 'rate_limit' | 'quota' | 'invalid_request' | 'content_policy' | 'transient' | 'provider_down' | 'unknown'

export interface ErrorClassification {
  kind: CanonicalError
  retryable: boolean
  retryAfterMs?: number
}

export interface CredentialStatus {
  ok: boolean
  errorCode?: string
  errorMessage?: string // redacted
  verifiedAt: string
}

export interface ModelCapabilities {
  text: boolean
  vision: boolean
  audio: boolean
  embeddings: boolean
  reasoning: boolean
  streaming: boolean
  toolCalling: boolean
  structuredOutput: boolean
  promptCaching: boolean
}

export interface ProviderHealth {
  ok: boolean
  checkedAt: string
  detail?: string
}

/**
 * A raw price document fetched from an allowed official source. The body is
 * kept as text so its SHA-256 can be recorded as evidence before parsing.
 */
export type BillableSourceType =
  'official_api' | 'official_market' | 'parsed_page' | 'imported_json' | 'imported_csv' | 'manual'

export interface PriceSourcePayload {
  sourceType: BillableSourceType
  url: string
  retrievedAt: Date
  contentType: string
  body: string
  parserVersion: string
  region: string
  currency: string
  billingConditions?: string
  evidenceRef?: string
}

export interface ProviderSourceAdapter {
  /** Provider code, e.g. 'openai'. */
  readonly id: string
  /** Observable adapter version; surface it in sync_runs and the console. */
  readonly version: string
  readonly authScheme: 'bearer' | 'x_api_key' | 'query'
  discoverModels(ctx: AdapterContext): Promise<NormalizedModel[]>
  validateCredential(ctx: AdapterContext): Promise<CredentialStatus>
  capabilities(model: string): ModelCapabilities
  classifyError(error: unknown): ErrorClassification
  health(ctx: AdapterContext): Promise<ProviderHealth>
  /**
   * Official structured/JSON price source, when the provider publishes one.
   * Most do not — those providers use the JSON/CSV import + human approval
   * pipeline instead. OPTIONAL by design.
   */
  fetchPriceSource?(ctx: AdapterContext): Promise<PriceSourcePayload[]>
}

export class RegistryError extends Error {
  constructor(
    public code: 'duplicate_adapter' | 'unknown_adapter' | 'invalid_adapter',
    message: string,
  ) {
    super(message)
    this.name = 'RegistryError'
  }
}

/** Conservative defaults; per-model confirmation happens at review time. */
const CHAT_DEFAULTS: ModelCapabilities = Object.freeze({
  text: true,
  vision: false,
  audio: false,
  embeddings: false,
  reasoning: false,
  streaming: true,
  toolCalling: false,
  structuredOutput: false,
  promptCaching: false,
})

export function classifyUpstreamError(error: unknown): ErrorClassification {
  const status = error instanceof UpstreamError ? error.status : undefined
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false }
  if (status === 429) return { kind: 'rate_limit', retryable: true, retryAfterMs: 1000 }
  if (status === 408) return { kind: 'transient', retryable: true }
  if (status === 400 || status === 422) return { kind: 'invalid_request', retryable: false }
  if (status === 402) return { kind: 'quota', retryable: false }
  if (status !== undefined && status >= 500) return { kind: 'provider_down', retryable: true }
  if (error instanceof TypeError) return { kind: 'transient', retryable: true } // fetch network failure
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return { kind: 'transient', retryable: true }
  return { kind: 'unknown', retryable: false }
}

export interface CatalogAdapterConfig {
  code: string
  version?: string
  authScheme: 'bearer' | 'x_api_key' | 'query'
  createCatalog: (ctx: AdapterContext) => {
    listModels(): Promise<NormalizedModel[]>
    verifyCredential(): Promise<CredentialStatus>
  }
  capabilities?: ModelCapabilities
  fetchPriceSource?: (ctx: AdapterContext) => Promise<PriceSourcePayload[]>
}

/** Wrap a Phase-0 catalog adapter as a source adapter. */
export function sourceAdapterFromCatalogConfig(cfg: CatalogAdapterConfig): ProviderSourceAdapter {
  return {
    id: cfg.code,
    version: cfg.version ?? '1',
    authScheme: cfg.authScheme,
    discoverModels: (ctx) => cfg.createCatalog(ctx).listModels(),
    validateCredential: (ctx) => cfg.createCatalog(ctx).verifyCredential(),
    capabilities: () => cfg.capabilities ?? CHAT_DEFAULTS,
    classifyError: classifyUpstreamError,
    async health(ctx) {
      const status = await cfg.createCatalog(ctx).verifyCredential()
      return { ok: status.ok, checkedAt: status.verifiedAt, detail: status.errorCode }
    },
    fetchPriceSource: cfg.fetchPriceSource,
  }
}

/**
 * Mutable registry. The default instance is pre-populated with the providers
 * NexusAPI ships; a deployment can register another adapter at startup without
 * touching the sync core.
 */
export class ProviderSourceRegistry {
  private readonly adapters = new Map<string, ProviderSourceAdapter>()

  register(adapter: ProviderSourceAdapter): void {
    if (!adapter?.id) throw new RegistryError('invalid_adapter', 'source adapter needs an id')
    if (this.adapters.has(adapter.id)) {
      throw new RegistryError('duplicate_adapter', `source adapter "${adapter.id}" is already registered`)
    }
    this.adapters.set(adapter.id, adapter)
  }

  unregister(id: string): boolean {
    return this.adapters.delete(id)
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }

  get(id: string): ProviderSourceAdapter | null {
    return this.adapters.get(id) ?? null
  }

  require(id: string): ProviderSourceAdapter {
    const adapter = this.get(id)
    if (!adapter) throw new RegistryError('unknown_adapter', `no source adapter registered for "${id}"`)
    return adapter
  }

  list(): ProviderSourceAdapter[] {
    return [...this.adapters.values()]
  }

  codes(): string[] {
    return [...this.adapters.keys()]
  }
}

/** The five providers NexusAPI currently supports. */
export function builtinSourceAdapters(): ProviderSourceAdapter[] {
  return [
    sourceAdapterFromCatalogConfig({
      code: 'openai',
      authScheme: 'bearer',
      createCatalog: createOpenAiCompatibleCatalog,
    }),
    sourceAdapterFromCatalogConfig({
      code: 'deepseek',
      authScheme: 'bearer',
      createCatalog: createOpenAiCompatibleCatalog,
    }),
    sourceAdapterFromCatalogConfig({
      code: 'qwen',
      authScheme: 'bearer',
      createCatalog: createOpenAiCompatibleCatalog,
    }),
    sourceAdapterFromCatalogConfig({
      code: 'anthropic',
      authScheme: 'x_api_key',
      createCatalog: createAnthropicCatalog,
    }),
    sourceAdapterFromCatalogConfig({
      code: 'gemini',
      authScheme: 'query',
      createCatalog: createGeminiCatalog,
    }),
  ]
}

export function createSourceRegistry(extra: ProviderSourceAdapter[] = []): ProviderSourceRegistry {
  const registry = new ProviderSourceRegistry()
  for (const adapter of [...builtinSourceAdapters(), ...extra]) registry.register(adapter)
  return registry
}

/** Process-wide registry used by the sync core. */
export const sourceRegistry = createSourceRegistry()

export type { AdapterContext, Capability, NormalizedModel }
