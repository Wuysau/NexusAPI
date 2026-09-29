// Payment provider registry. Fail-closed: an unknown provider name is an
// error, never a fallback to a permissive default.

import { MOCK_PROVIDER_NAME, MockPaymentProvider } from './mock'
import { PaymentError, type PaymentProvider } from './types'
import { StripePaymentProvider } from './stripe'
export { StripePaymentProvider, stripeConfiguration, microsToMinorUnits } from './stripe'

export * from './types'
export {
  MOCK_PROVIDER_NAME,
  MockPaymentProvider,
  MOCK_WEBHOOK_SECRET_ENV,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
  mockSignature,
  mockSignedPayload,
  buildSandboxWebhookRequest,
  type SandboxWebhookEvent,
  type SandboxWebhookOptions,
} from './mock'

export type PaymentProviderName = 'mock' | 'stripe'

const FACTORIES: Record<string, () => PaymentProvider> = {
  [MOCK_PROVIDER_NAME]: () => new MockPaymentProvider(),
  stripe: () => new StripePaymentProvider(),
}

/** Resolve a provider by name. Throws PaymentError for anything unknown. */
export function getPaymentProvider(name: string | null | undefined): PaymentProvider {
  const key = (name ?? '').trim().toLowerCase()
  const factory = FACTORIES[key]
  if (!factory) {
    throw new PaymentError('unknown_provider', `unknown payment provider: ${String(name)}`, 404)
  }
  return factory()
}

export function listPaymentProviders(): string[] {
  return Object.keys(FACTORIES)
}
