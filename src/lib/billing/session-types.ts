export const sessionTokenNames = ['input', 'cached', 'reasoning', 'output', 'total'] as const
export type SessionTokenName = (typeof sessionTokenNames)[number]
export type SessionTokens = Record<SessionTokenName, string | null>
export interface SessionDetail {
  id: string
  kind: string | null
  parentId: string | null
  firstActivity: string
  lastActivity: string
  events: string
  models: string[]
  tokens: SessionTokens
  subscriptionTokens: SessionTokens
}
export interface SessionDetailsResponse {
  sessions: SessionDetail[]
  subscriptionTotals: SessionTokens
  totalSessions: string
  nextOffset: number | null
  asOf: string
}
/** Exact integer arithmetic; unknown or absent denominator is never rendered as 0%. */
export function tokenShare(value: string | null, denominator: string | null): string | null {
  if (value === null || denominator === null || BigInt(denominator) <= 0n) return null
  const scaled = (BigInt(value) * 10000n + BigInt(denominator) / 2n) / BigInt(denominator)
  return `${scaled / 100n}.${String(scaled % 100n).padStart(2, '0')}%`
}
