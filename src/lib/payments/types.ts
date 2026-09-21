// Payment provider contract (Work Item G).
//
// A PaymentProvider is the ONLY way the control plane talks to a payment
// processor. It is deliberately narrow:
//
//   - createCheckout starts a payment. Its result NEVER means "paid": a browser
//     redirect (or a sandbox approval) is not proof of payment (INVARIANT #15).
//     Only a verified webhook may settle an order.
//   - verifyWebhook authenticates and parses an inbound callback. It must be
//     signature-verified, replay-resistant and idempotent by event id.
//   - refund asks the processor to reverse a charge. The ledger compensation is
//     posted by the caller, not here.
//
// No provider-specific branch belongs outside src/lib/payments/<provider>.ts.

import type { Micros } from '@/lib/money'

export interface CheckoutParams {
  orderId: string
  amount: Micros
  currency: string
  tenantId: string
}

/**
 * Outcome of starting a checkout.
 *
 * `sandbox: true` is a hard marker meaning NO real money moved. A production
 * caller must never treat `status: 'sandbox'` as success — it only means the
 * hosted/sandbox checkout page was prepared.
 */
export interface CheckoutResult {
  provider: string
  status: 'sandbox' | 'pending' | 'created'
  sandbox: boolean
  externalOrderId: string | null
  checkoutUrl: string | null
  /** The only settlement path is the webhook. */
  confirmation: 'webhook_only'
}

export type VerifiedPaymentEventType = 'payment.succeeded' | 'payment.failed'

export interface VerifiedPaymentEvent {
  provider: string
  /** Provider-assigned event id. Unique per tenant for idempotency. */
  eventId: string
  type: VerifiedPaymentEventType
  /** Our order id, echoed back by the provider. */
  orderId: string | null
  externalOrderId: string | null
  /** Amount the provider reports. Verified against the server-side order. */
  amount: Micros
  currency: string
  occurredAt: Date
  /** Raw provider payload, stored for audit. Never trusted for amounts. */
  raw: Record<string, unknown>
}

export interface RefundParams {
  /** Ledger transaction id of the original recharge being compensated. */
  originalTransactionId: string
  amount: Micros
  reason: string
  /** Optional context a concrete provider needs; sandbox ignores it. */
  orderId?: string
  currency?: string
  tenantId?: string
  /** Provider-side idempotency key (we pass the deterministic order key). */
  idempotencyKey?: string
}

export interface RefundResult {
  provider: string
  status: 'sandbox' | 'pending' | 'completed' | 'failed'
  sandbox: boolean
  refundId: string | null
  reason?: string
}

export interface PaymentProvider {
  readonly name: string
  createCheckout(params: CheckoutParams): Promise<CheckoutResult>
  verifyWebhook(req: Request): Promise<VerifiedPaymentEvent>
  refund(params: RefundParams): Promise<RefundResult>
}

export type PaymentErrorCode =
  | 'provider_not_configured'
  | 'unknown_provider'
  | 'mock_forbidden_in_production'
  | 'missing_signature'
  | 'invalid_signature'
  | 'timestamp_out_of_window'
  | 'malformed_event'
  | 'unsupported_event_type'

export class PaymentError extends Error {
  readonly status: number
  readonly code: PaymentErrorCode

  constructor(code: PaymentErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'PaymentError'
    this.code = code
    this.status = status
  }
}

/** HTTP status for a payment/provider failure. Verification failures are 401. */
export function paymentErrorStatus(err: unknown): number {
  if (err instanceof PaymentError) return err.status
  return 500
}
