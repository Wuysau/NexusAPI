/** Transient text-only console contract. No provider extensions are accepted as input. */
export const PLAYGROUND_LIMITS = {
  inputBytes: 65_536,
  responseBytes: 1_048_576,
  messages: 64,
  outputTokens: 8_192,
  timeoutMs: 60_000,
} as const

export interface PlaygroundIdentity {
  projectId: string
  apiKey: string
}
export interface PlaygroundMessage {
  role: 'user' | 'assistant'
  content: string
}
export interface PlaygroundChatInput extends PlaygroundIdentity {
  model: string
  messages: PlaygroundMessage[]
  maxTokens: number
}
export interface PlaygroundModelsResponse {
  version: 1
  models: { id: string }[]
  requestId: string | null
}
export interface PlaygroundUsage {
  inputTokens: string | null
  outputTokens: string | null
  cachedInputTokens: string | null
  reasoningTokens: string | null
  totalTokens: string | null
}
export interface PlaygroundChatResponse {
  version: 1
  model: string
  requestId: string | null
  assistant: { content: string | null; refusal: string | null }
  finishReason: string | null
  usage: PlaygroundUsage
  canContinue: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function identifier(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}
function identity(value: Record<string, unknown>): boolean {
  return (
    identifier(value.projectId) &&
    typeof value.apiKey === 'string' &&
    /^sk-nx-[A-Za-z0-9_-]{18,250}$/.test(value.apiKey)
  )
}

export function isPlaygroundModelsInput(value: unknown): value is PlaygroundIdentity {
  return record(value) && exactKeys(value, ['projectId', 'apiKey']) && identity(value)
}
export function isPlaygroundChatInput(value: unknown): value is PlaygroundChatInput {
  if (
    !record(value) ||
    !exactKeys(value, ['projectId', 'apiKey', 'model', 'messages', 'maxTokens']) ||
    !identity(value)
  )
    return false
  if (
    !identifier(value.model, 256) ||
    !Number.isSafeInteger(value.maxTokens) ||
    (value.maxTokens as number) < 1 ||
    (value.maxTokens as number) > PLAYGROUND_LIMITS.outputTokens
  )
    return false
  const messages = value.messages
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > PLAYGROUND_LIMITS.messages) return false
  if (
    !messages.every(
      (message, index) =>
        record(message) &&
        exactKeys(message, ['role', 'content']) &&
        message.role === (index % 2 ? 'assistant' : 'user') &&
        typeof message.content === 'string' &&
        message.content.length > 0 &&
        message.content.trim().length > 0,
    )
  )
    return false
  return messages[messages.length - 1].role === 'user'
}

/** Counters are independently reported evidence; no sums or missing-to-zero normalization. */
function counter(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n)
    return value
  throw new Error('Invalid Playground response')
}
function details(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (!record(value)) throw new Error('Invalid Playground response')
  return value
}
export function playgroundRequestId(value: string | null): string | null {
  return value !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) ? value : null
}

export function projectPlaygroundModels(value: unknown, requestId: string | null): PlaygroundModelsResponse {
  if (!record(value) || value.object !== 'list' || !Array.isArray(value.data) || value.data.length > 4096)
    throw new Error('Invalid Playground response')
  const seen = new Set<string>()
  const models = value.data.map((item) => {
    if (!record(item) || !identifier(item.id, 256) || seen.has(item.id)) throw new Error('Invalid Playground response')
    seen.add(item.id)
    return { id: item.id }
  })
  return { version: 1, models, requestId: playgroundRequestId(requestId) }
}

export function projectPlaygroundChat(value: unknown, requestId: string | null): PlaygroundChatResponse {
  if (
    !record(value) ||
    value.object !== 'chat.completion' ||
    !identifier(value.model, 256) ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  )
    throw new Error('Invalid Playground response')
  const choice = value.choices[0]
  if (!record(choice) || choice.index !== 0 || !record(choice.message) || choice.message.role !== 'assistant')
    throw new Error('Invalid Playground response')
  const message = choice.message
  // Any additional assistant state requires its own replay contract. Even an
  // empty/null field is evidence of a richer envelope, never ordinary text.
  const semanticFields = Object.keys(message).some((key) => key !== 'role' && key !== 'content')
  if (
    message.content !== null &&
    typeof message.content !== 'string' &&
    !(message.content === undefined && semanticFields)
  )
    throw new Error('Invalid Playground response')
  if (Object.hasOwn(message, 'refusal') && message.refusal !== null && typeof message.refusal !== 'string')
    throw new Error('Invalid Playground response')
  if (choice.finish_reason !== null && !identifier(choice.finish_reason, 64))
    throw new Error('Invalid Playground response')
  const rawUsage = details(value.usage)
  const promptDetails = details(rawUsage.prompt_tokens_details)
  const completionDetails = details(rawUsage.completion_tokens_details)
  return {
    version: 1,
    model: value.model,
    requestId: playgroundRequestId(requestId),
    assistant: {
      content: typeof message.content === 'string' ? message.content : null,
      refusal: typeof message.refusal === 'string' ? message.refusal : null,
    },
    finishReason: choice.finish_reason as string | null,
    usage: {
      inputTokens: counter(rawUsage.prompt_tokens),
      outputTokens: counter(rawUsage.completion_tokens),
      cachedInputTokens: counter(promptDetails.cached_tokens),
      reasoningTokens: counter(completionDetails.reasoning_tokens),
      totalTokens: counter(rawUsage.total_tokens),
    },
    canContinue:
      !semanticFields &&
      choice.finish_reason === 'stop' &&
      typeof message.content === 'string' &&
      message.content.trim().length > 0,
  }
}
