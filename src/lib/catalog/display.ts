// Presentation metadata for the model catalog.
//
// DISPLAY ONLY. This module answers "which providers and models exist for the
// UI to render" — it carries NO prices and NO billing semantics. Runtime
// billing reads approved price versions from the database (see
// src/lib/db/schema.ts `provider_price_versions` / `price_components`), never
// from this file. The price record schema lives in
// packages/contracts/schemas/price-record.schema.json.
//
// The legacy price compatibility shim has been removed. This module
// remains presentation-only; model availability/prices come from the API.

export interface ProviderDisplay {
  id: string
  name: string
  url: string
  color: string
  mark: string
}

export interface ModelDisplay {
  id: string
  provider: string
  context: string
  name: string
}

export const providers: readonly ProviderDisplay[] = [
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', color: '#25a582', mark: '◎' },
  { id: 'anthropic', name: 'Anthropic', url: 'https://api.anthropic.com/v1', color: '#ce987a', mark: '✳' },
  {
    id: 'gemini',
    name: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    color: '#5889ee',
    mark: '✦',
  },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1', color: '#537fea', mark: '≈' },
  {
    id: 'qwen',
    name: '通义千问',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    color: '#9270e1',
    mark: '❖',
  },
]

// No `input` / `output` fields: prices are versioned data, not source constants.
export const models: readonly ModelDisplay[] = [
  { id: 'gpt-4o', provider: 'openai', context: '128K', name: 'GPT-4o' },
  { id: 'gpt-4o-mini', provider: 'openai', context: '128K', name: 'GPT-4o mini' },
  { id: 'claude-sonnet-4-20250514', provider: 'anthropic', context: '200K', name: 'Claude Sonnet 4' },
  { id: 'gemini-2.5-flash', provider: 'gemini', context: '1M', name: 'Gemini 2.5 Flash' },
  { id: 'deepseek-chat', provider: 'deepseek', context: '64K', name: 'DeepSeek V3' },
  { id: 'deepseek-reasoner', provider: 'deepseek', context: '64K', name: 'DeepSeek R1' },
  { id: 'qwen-plus', provider: 'qwen', context: '128K', name: '通义千问 Plus' },
]
