export type OwnedAccessAccountingKind = 'api_usage' | 'subscription_quota' | 'nexus_service_fee'

export interface ApiUsageAccounting {
  kind: 'api_usage'
  tenant_id: string
  connector_id: string
  price_version_id?: string
  input_tokens?: number
  output_tokens?: number
  authoritative: boolean
}

export interface SubscriptionQuotaAccounting {
  metadata?: import('./quota').QuotaSnapshotMetadata
  kind: 'subscription_quota'
  tenant_id: string
  connector_id: string
  plan: string
  window: string
  used?: number | string | null
  remaining?: number | string | null
  reset_at?: string
  source: string
  observed_at: string
  stale_at: string
  confidence: 'authoritative' | 'reported' | 'estimated' | 'unknown'
}

export interface NexusServiceFeeAccounting {
  kind: 'nexus_service_fee'
  tenant_id: string
  fee_minor: bigint
  currency: string
  price_version_id: string
}

export type OwnedAccessAccounting = ApiUsageAccounting | SubscriptionQuotaAccounting | NexusServiceFeeAccounting

export function createsMoneyPosting(entry: OwnedAccessAccounting): boolean {
  if (entry.kind === 'nexus_service_fee') return true
  return entry.kind === 'api_usage' && entry.authoritative && entry.price_version_id !== undefined
}
