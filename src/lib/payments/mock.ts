// MockPaymentProvider — SANDBOX ONLY.
//
// This provider exists so the order/webhook/refund machinery can be exercised
// without a real processor. It is explicitly NOT a payment integration and it
// refuses to run in production:
//
//   - createCheckout "approves" nothing. It returns `status: 'sandbox'` and the
//     order stays `pending` until a signed webhook arrives. No fake success.
//   - refund returns `status: 'sandbox'`; no money moves.
//   - verifyWebhook DOES enforce the real contract (HMAC signature, timestamp
//     window) so the production verification path is what gets tested.
//
// The shared secret comes from MOCK_PAYMENT_WEBHOOK_SECRET. The provider fails
// closed when it is unset, so a misconfigured deployment cannot accept unsigned
// callbacks.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Micros } from '@/lib/money'
import {
  PaymentError,
  type CheckoutParams,
  type CheckoutResult,
  type PaymentProvider,
  type RefundParams,
  type RefundResult,
  type VerifiedPaymentEvent,
  type VerifiedPaymentEventType,
} from './types'

export const MOCK_PROVIDER_NAME = 'mock'
export const MOCK_WEBHOOK_SECRET_ENV = 'MOCK_PAYMENT_WEBHOOK_SECRET'
export const WEBHOOK_SIGNATURE_HEADER = 'x-nexus-signature'
export const WEBHOOK_TIMESTAMP_HEADER = 'x-nexus-timestamp'
/** Replay window: an event whose timestamp is older/newer than this is rejected. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60

/** Canonical signed payload: `<timestamp>.<raw body>`. */
export function mockSignedPayload(rawBody: string, timestamp: string | number): string {
  return `${timestamp}.${rawBody}`
}

export function mockSignature(rawBody: string, timestamp: string | number, secret: string): string {
  return createHmac('sha256', secret).update(mockSignedPayload(rawBody, timestamp)).digest('hex')
}

export interface SandboxWebhookEvent {
  id: string
  type: VerifiedPaymentEventType
  orderId: string
  externalOrderId?: string
  amount: Micros
  currency: string
  occurredAt?: Date
  [key: string]: unknown
}

export interface SandboxWebhookOptions {
  secret: string
  /** Unix seconds; defaults to now. */
  timestamp?: number
  url?: string
}

/**
 * Build a correctly signed sandbox webhook Request. Used by integration tests
 * and by the sandbox console to simulate a processor callback. It only works
 * with the shared mock secret, so it cannot forge a real provider's events.
 */
export function buildSandboxWebhookRequest(event: SandboxWebhookEvent, options: SandboxWebhookOptions): Request {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
  const body = JSON.stringify({
    id: event.id,
    type: event.type,
    occurred_at: (event.occurredAt ?? new Date()).toISOString(),
    data: {
      order_id: event.orderId,
      external_order_id: event.externalOrderId ?? null,
      amount: event.amount.toString(),
      currency: event.currency,
      ...Object.fromEntries(
        Object.entries(event).filter(
          ([k]) => !['id', 'type', 'orderId', 'externalOrderId', 'amount', 'currency', 'occurredAt'].includes(k),
        ),
      ),
    },
  })
  const signature = mockSignature(body, timestamp, options.secret)
  return new Request(options.url ?? 'http://localhost/api/webhooks/payments/mock', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [WEBHOOK_SIGNATURE_HEADER]: `sha256=${signature}`,
      [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
    },
    body,
  })
}

function readHeader(req: Request, name: string): string | null {
  const value = req.headers.get(name)
  return value && value.trim() ? value.trim() : null
}

function constantTimeHexEqual(a: string, b: string): boolean {
  // Hash both sides so the comparison is over fixed-length buffers and neither
  // content nor length leaks through timing.
  const left = createHmac('sha256', 'cmp').update(a).digest()
  const right = createHmac('sha256', 'cmp').update(b).digest()
  return timingSafeEqual(left, right)
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = MOCK_PROVIDER_NAME
  private readonly secret: string

  constructor(secret?: string) {
    if ((process.env.NODE_ENV ?? 'development') === 'production') {
      // Sandbox payments must never be reachable from a production deployment.
      throw new PaymentError(
        'mock_forbidden_in_production',
        'MockPaymentProvider is sandbox-only and cannot be used in production',
        503,
      )
    }
    const resolved = (secret ?? process.env[MOCK_WEBHOOK_SECRET_ENV] ?? '').trim()
    if (!resolved) {
      throw new PaymentError(
        'provider_not_configured',
        `${MOCK_WEBHOOK_SECRET_ENV} is not configured; mock payments are disabled`,
        503,
      )
    }
    this.secret = resolved
  }

  async createCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    // No approval, no capture, no fake success: the order remains pending and
    // only a verified webhook can settle it.
    return {
      provider: this.name,
      status: 'sandbox',
      sandbox: true,
      externalOrderId: `mock_order_${params.orderId}`,
      checkoutUrl: `http://localhost/sandbox/payments/${params.orderId}`,
      confirmation: 'webhook_only',
    }
  }

  async verifyWebhook(req: Request): Promise<VerifiedPaymentEvent> {
    const rawBody = await req.text()
    const timestampHeader = readHeader(req, WEBHOOK_TIMESTAMP_HEADER)
    const signatureHeader = readHeader(req, WEBHOOK_SIGNATURE_HEADER)
    if (!timestampHeader || !signatureHeader) {
      throw new PaymentError('missing_signature', 'webhook is missing its signature headers', 401)
    }

    const timestamp = Number(timestampHeader)
    if (!Number.isFinite(timestamp)) {
      throw new PaymentError('missing_signature', 'webhook timestamp is not a number', 401)
    }
    const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp)
    if (skewSeconds > WEBHOOK_TOLERANCE_SECONDS) {
      throw new PaymentError('timestamp_out_of_window', 'webhook timestamp is outside the replay window', 401)
    }

    const presented = signatureHeader.startsWith('sha256=') ? signatureHeader.slice('sha256='.length) : signatureHeader
    const expected = mockSignature(rawBody, timestamp, this.secret)
    if (!constantTimeHexEqual(presented, expected)) {
      throw new PaymentError('invalid_signature', 'webhook signature verification failed', 401)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      throw new PaymentError('malformed_event', 'webhook body is not valid JSON', 400)
    }
    return this.toVerifiedEvent(parsed)
  }

  async refund(params: RefundParams): Promise<RefundResult> {
    return {
      provider: this.name,
      status: 'sandbox',
      sandbox: true,
      refundId: `mock_refund_${params.originalTransactionId}`,
      reason: params.reason,
    }
  }

  private toVerifiedEvent(parsed: unknown): VerifiedPaymentEvent {
    if (!parsed || typeof parsed !== 'object') {
      throw new PaymentError('malformed_event', 'webhook payload must be an object', 400)
    }
    const body = parsed as Record<string, unknown>
    const data = (body.data ?? {}) as Record<string, unknown>
    const id = body.id
    const type = body.type
    const orderId = data.order_id
    const amount = data.amount
    const currency = data.currency
    if (typeof id !== 'string' || !id) {
      throw new PaymentError('malformed_event', 'webhook id is required', 400)
    }
    if (type !== 'payment.succeeded' && type !== 'payment.failed') {
      throw new PaymentError('unsupported_event_type', `unsupported event type: ${String(type)}`, 400)
    }
    if (typeof orderId !== 'string' || !orderId) {
      throw new PaymentError('malformed_event', 'webhook data.order_id is required', 400)
    }
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
      throw new PaymentError('malformed_event', 'webhook data.amount must be an integer micros string', 400)
    }
    const occurredRaw = body.occurred_at
    const occurredAt = typeof occurredRaw === 'string' ? new Date(occurredRaw) : new Date()
    return {
      provider: this.name,
      eventId: id,
      type,
      orderId,
      externalOrderId: typeof data.external_order_id === 'string' ? data.external_order_id : null,
      amount: BigInt(amount),
      currency: typeof currency === 'string' && currency ? currency : 'USD',
      occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
      raw: body,
    }
  }
}
