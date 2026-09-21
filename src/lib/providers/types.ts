// Provider adapter contracts. Every provider integrates through these two
// interfaces so the sync/price pipelines stay provider-agnostic.
//
// Per the spec: model sync and price sync are SEPARATE flows. /v1/models does
// not return prices. Never derive prices from model ids or from search/blog
// content. Price records always carry source evidence.

export type Capability =
  | 'text'
  | 'vision'
  | 'audio'
  | 'embeddings'
  | 'reasoning'
  | 'streaming'
  | 'tool_calling'
  | 'structured_output'
  | 'prompt_caching'

export type LifecycleStatus = 'draft' | 'pending_review' | 'active' | 'deprecated' | 'retired'

export interface NormalizedModel {
  upstreamModelId: string
  displayName: string
  description?: string
  contextWindow?: number
  maxOutputTokens?: number
  capabilities: Capability[]
  lifecycle: LifecycleStatus
  rawMetadata?: Record<string, unknown>
}

export interface CredentialVerificationResult {
  ok: boolean
  errorCode?: string
  errorMessage?: string // must be redacted before storage/display
  verifiedAt: string // ISO
}

export interface ModelCatalogAdapter {
  /** List models from the provider's official models endpoint. */
  listModels(): Promise<NormalizedModel[]>
  /** Verify a credential against the provider without charging. */
  verifyCredential(): Promise<CredentialVerificationResult>
}

export type PriceUnit = 'per_million_tokens' | 'per_token' | 'per_request' | 'per_image' | 'per_second'
export type PriceSourceType =
  'official_api' | 'official_market' | 'parsed_page' | 'imported_json' | 'imported_csv' | 'manual'

export interface NormalizedPriceRecord {
  upstreamModelId: string
  currency: string // ISO 4217
  region: string
  serviceTier: string
  contextMin?: number | null
  contextMax?: number | null
  inputPrice: string // numeric string, in `currency` per `unit`
  cachedInputPrice?: string
  cacheWritePrice?: string
  outputPrice: string
  reasoningPrice?: string
  requestPrice?: string
  toolPrice?: string
  imagePrice?: string
  audioPrice?: string
  unit: PriceUnit
  sourceType: PriceSourceType
  sourceUrl?: string
  sourceDocumentHash?: string
  fetchedAt?: string // ISO
  effectiveFrom?: string
  rawSourceData?: Record<string, unknown>
}

export interface PricingSourceAdapter {
  /** Fetch machine-readable pricing. Never scrapes live at request time. */
  fetchPricing(): Promise<NormalizedPriceRecord[]>
}

export interface AdapterContext {
  baseUrl: string
  modelsEndpoint?: string
  authScheme: 'bearer' | 'x_api_key' | 'query'
  /** Plaintext credential, already decrypted by the caller. Never logged. */
  secret: string
  /** Extra query params, e.g. API key param name for `query` auth. */
  query?: Record<string, string>
  /** Per-request timeout for upstream calls (ms). */
  timeoutMs?: number
  /** AbortSignal for cancellation (streaming, client disconnect). */
  signal?: AbortSignal
}

export interface AdapterFactory {
  code: string // provider code, e.g. 'openai'
  createCatalog(ctx: AdapterContext): ModelCatalogAdapter
  createPricing?(ctx: AdapterContext): PricingSourceAdapter
}
