// Provider registry: maps a provider `code` to its adapter factories.
//
// Pricing adapters are OPTIONAL per provider — most providers have no
// machine-readable price API. Those providers use the JSON/CSV import +
// human-approval pipeline (see src/lib/pricing/import.ts) instead. We never
// scrape live at request time.

import type { AdapterContext, ModelCatalogAdapter, PricingSourceAdapter } from './types'
import { createOpenAiCompatibleCatalog } from './openai-compatible'
import { createAnthropicCatalog } from './anthropic'
import { createGeminiCatalog } from './gemini'

type CatalogCtor = (ctx: AdapterContext) => ModelCatalogAdapter

interface ProviderAdapterConfig {
  code: string
  authScheme: 'bearer' | 'x_api_key' | 'query'
  createCatalog: CatalogCtor
  createPricing?: (ctx: AdapterContext) => PricingSourceAdapter
}

const REGISTRY: ProviderAdapterConfig[] = [
  { code: 'openai', authScheme: 'bearer', createCatalog: createOpenAiCompatibleCatalog },
  { code: 'deepseek', authScheme: 'bearer', createCatalog: createOpenAiCompatibleCatalog },
  { code: 'qwen', authScheme: 'bearer', createCatalog: createOpenAiCompatibleCatalog },
  { code: 'anthropic', authScheme: 'x_api_key', createCatalog: createAnthropicCatalog },
  { code: 'gemini', authScheme: 'query', createCatalog: createGeminiCatalog },
]

const MAP: Record<string, ProviderAdapterConfig> = Object.fromEntries(REGISTRY.map((r) => [r.code, r]))

export function getAdapterConfig(code: string): ProviderAdapterConfig | null {
  return MAP[code] ?? null
}

export function createCatalog(code: string, ctx: AdapterContext): ModelCatalogAdapter {
  const cfg = getAdapterConfig(code)
  if (!cfg) throw new Error(`provider: no adapter registered for "${code}"`)
  return cfg.createCatalog(ctx)
}

export function listSupportedProviderCodes(): string[] {
  return REGISTRY.map((r) => r.code)
}
