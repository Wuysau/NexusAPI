/** Explicit product mapping to CodexBar's documented provider registry. Native Codex stays separate. */
export const COLLECTOR_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  claude_code: ['claude'],
  google_gemini: ['gemini'],
  github_copilot: ['copilot'],
  cursor: ['cursor'],
  windsurf: ['windsurf'],
  kiro: ['kiro'],
  jetbrains_ai: ['jetbrains'],
  kimi_coding: ['kimi'],
  zai_glm: ['zai'],
  minimax_coding: ['minimax'],
  alibaba_bailian: ['alibaba', 'alibabatokenplan'],
  deepseek: ['deepseek'],
  xai_grok: ['grok', 'xai'],
  perplexity: ['perplexity'],
}
export function supportsSubscriptionMonitor(productId: string) {
  return Object.hasOwn(COLLECTOR_PROVIDERS, productId)
}
export function collectorProviders(productId: string): readonly string[] {
  return Object.hasOwn(COLLECTOR_PROVIDERS, productId) ? COLLECTOR_PROVIDERS[productId] : []
}
