import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  PaymentError,
  type CheckoutParams,
  type CheckoutResult,
  type PaymentProvider,
  type RefundParams,
  type RefundResult,
  type VerifiedPaymentEvent,
} from './types'

// Deliberately explicit. Special-case currencies such as ISK/UGX and
// three-decimal currencies are unsupported until their rules are implemented.
export const STRIPE_CURRENCY_DECIMALS: Readonly<Record<string, number>> = Object.freeze({
  USD: 2,
  EUR: 2,
  GBP: 2,
  CNY: 2,
  HKD: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  CHF: 2,
  JPY: 0,
  KRW: 0,
})
export function microsToMinorUnits(amount: bigint, currency: string): number {
  const decimals = STRIPE_CURRENCY_DECIMALS[currency]
  if (decimals === undefined) throw new PaymentError('invalid_amount', 'Unsupported checkout currency.')
  const divisor = 10n ** BigInt(6 - decimals)
  if (amount <= 0n || amount % divisor !== 0n || amount / divisor > 99_999_999n)
    throw new PaymentError(
      'invalid_amount',
      'Price must be positive, exactly representable in currency minor units, and within Stripe limits.',
    )
  return Number(amount / divisor)
}

interface StripeConfig {
  secretKey: string
  webhookSecret: string
  mode: 'test' | 'live'
  origin: string
}
function readConfig(): StripeConfig {
  return {
    secretKey: process.env.STRIPE_SECRET_KEY?.trim() ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? '',
    mode: process.env.STRIPE_MODE as StripeConfig['mode'],
    origin: process.env.STRIPE_CHECKOUT_ORIGIN?.trim() ?? '',
  }
}
function validateConfig(config: StripeConfig): StripeConfig {
  const fail = () => {
    throw new PaymentError(
      'provider_not_configured',
      'Stripe merchant configuration is unavailable or inconsistent.',
      503,
    )
  }
  if (
    !['test', 'live'].includes(config.mode) ||
    !config.secretKey.startsWith(`sk_${config.mode}_`) ||
    !config.webhookSecret.startsWith('whsec_')
  )
    fail()
  let url: URL
  try {
    url = new URL(config.origin)
  } catch {
    return fail()
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail()
  if (
    url.protocol !== 'https:' &&
    !(config.mode === 'test' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
  )
    fail()
  return { ...config, origin: url.origin }
}
/** Safe for the browser; never return keys or webhook secrets. */
export function stripeConfiguration(): { configured: boolean; mode: 'test' | 'live' | null; currencies: string[] } {
  try {
    const config = validateConfig(readConfig())
    return { configured: true, mode: config.mode, currencies: Object.keys(STRIPE_CURRENCY_DECIMALS) }
  } catch {
    return { configured: false, mode: null, currencies: Object.keys(STRIPE_CURRENCY_DECIMALS) }
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PaymentError('malformed_event', 'Invalid Stripe event structure.')
  return value as Record<string, unknown>
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
}
async function boundedBody(req: Request): Promise<Buffer> {
  const reader = req.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1_048_576) {
        await reader.cancel().catch(() => {})
        throw new PaymentError('malformed_event', 'Stripe event is too large.', 413)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks, size)
  } finally {
    reader.releaseLock()
  }
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe'
  get mode(): 'test' | 'live' {
    return this.config.mode
  }
  private readonly config: StripeConfig
  constructor(config?: StripeConfig) {
    this.config = validateConfig(config ?? readConfig())
  }

  async createCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    const amount = microsToMinorUnits(params.amount, params.currency)
    const body = new URLSearchParams({
      mode: 'payment',
      success_url: `${this.config.origin}/billing?checkout=returned`,
      cancel_url: `${this.config.origin}/billing?checkout=cancelled`,
      client_reference_id: params.orderId,
      'metadata[order_id]': params.orderId,
      'metadata[tenant_id]': params.tenantId,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': params.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(amount),
      'line_items[0][price_data][product_data][name]': 'NexusAPI plan access',
      'payment_method_types[0]': 'card',
      'adaptive_pricing[enabled]': 'false',
    })
    let session: Record<string, unknown>
    try {
      const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: `Bearer ${this.config.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': `nexus-checkout:${params.orderId}`,
          'stripe-version': '2025-02-24.acacia',
        },
        body: body.toString(),
      })
      if (!response.ok) throw new Error('processor rejected checkout')
      session = object(await response.json())
      const metadata = object(session.metadata)
      const url = new URL(String(session.url))
      if (
        !nonempty(session.id) ||
        !session.id.startsWith('cs_') ||
        session.livemode !== (this.config.mode === 'live') ||
        session.amount_total !== amount ||
        session.currency !== params.currency.toLowerCase() ||
        session.client_reference_id !== params.orderId ||
        metadata.order_id !== params.orderId ||
        metadata.tenant_id !== params.tenantId ||
        url.protocol !== 'https:' ||
        url.hostname !== 'checkout.stripe.com' ||
        url.username ||
        url.password ||
        !Number.isSafeInteger(session.expires_at)
      )
        throw new Error('invalid checkout response')
    } catch {
      throw new PaymentError('processor_error', 'Stripe checkout could not be created. Retry the same order.', 502)
    }
    return {
      provider: this.name,
      status: 'created',
      sandbox: this.config.mode === 'test',
      mode: this.config.mode,
      externalOrderId: session.id as string,
      checkoutUrl: session.url as string,
      expiresAt: session.expires_at as number,
      confirmation: 'webhook_only',
    }
  }

  async verifyWebhook(req: Request): Promise<VerifiedPaymentEvent> {
    const raw = await boundedBody(req)
    const header = req.headers.get('stripe-signature')
    if (!header) throw new PaymentError('missing_signature', 'Stripe signature is required.', 401)
    const entries = header.split(',').map((part) => part.trim().split('='))
    const timestamps = entries.filter(([key]) => key === 't')
    const timestamp = timestamps[0]?.[1] ?? ''
    if (timestamps.length !== 1 || !/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)))
      throw new PaymentError('invalid_signature', 'Invalid Stripe signature.', 401)
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300)
      throw new PaymentError('timestamp_out_of_window', 'Stripe signature timestamp is outside the replay window.', 401)
    const expected = createHmac('sha256', this.config.webhookSecret).update(`${timestamp}.`).update(raw).digest()
    const valid = entries.some(
      ([key, value]) =>
        key === 'v1' && /^[a-f0-9]{64}$/i.test(value ?? '') && timingSafeEqual(Buffer.from(value, 'hex'), expected),
    )
    if (!valid) throw new PaymentError('invalid_signature', 'Invalid Stripe signature.', 401)
    let parsed: Record<string, unknown>
    try {
      parsed = object(JSON.parse(raw.toString('utf8')))
    } catch {
      throw new PaymentError('malformed_event', 'Invalid Stripe event JSON.')
    }
    if (
      !nonempty(parsed.id) ||
      typeof parsed.type !== 'string' ||
      !Number.isSafeInteger(parsed.created) ||
      Number(parsed.created) <= 0 ||
      parsed.livemode !== (this.config.mode === 'live')
    )
      throw new PaymentError('malformed_event', 'Stripe event identity or mode does not match.')
    const occurredAt = new Date(Number(parsed.created) * 1000)
    if (!Number.isFinite(occurredAt.getTime()))
      throw new PaymentError('malformed_event', 'Stripe event time is invalid.')
    const base = { provider: this.name, mode: this.mode, eventId: parsed.id, occurredAt }
    const ignored: VerifiedPaymentEvent = {
      ...base,
      type: 'ignored',
      orderId: null,
      externalOrderId: null,
      amount: 0n,
      currency: '',
      raw: { id: parsed.id, type: parsed.type },
    }
    if (
      ![
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded',
        'checkout.session.async_payment_failed',
        'checkout.session.expired',
      ].includes(parsed.type)
    )
      return ignored
    const session = object(object(parsed.data).object)
    const metadata = object(session.metadata)
    if (
      session.object !== 'checkout.session' ||
      !nonempty(session.id) ||
      !session.id.startsWith('cs_') ||
      session.mode !== 'payment' ||
      session.livemode !== (this.config.mode === 'live') ||
      !nonempty(metadata.order_id) ||
      !nonempty(metadata.tenant_id) ||
      session.client_reference_id !== metadata.order_id ||
      typeof session.currency !== 'string' ||
      !Number.isSafeInteger(session.amount_total) ||
      Number(session.amount_total) <= 0
    )
      throw new PaymentError('malformed_event', 'Stripe Checkout session is incomplete or inconsistent.')
    const currency = session.currency.toUpperCase()
    const decimals = STRIPE_CURRENCY_DECIMALS[currency]
    if (decimals === undefined) throw new PaymentError('invalid_amount', 'Unsupported checkout currency.')
    const amount = BigInt(Number(session.amount_total)) * 10n ** BigInt(6 - decimals)
    microsToMinorUnits(amount, currency)
    const failed = ['checkout.session.async_payment_failed', 'checkout.session.expired'].includes(parsed.type)
    if (!failed && session.payment_status !== 'paid') return ignored
    if (!failed && session.status !== 'complete')
      throw new PaymentError('malformed_event', 'Paid Checkout session is not complete.')
    return {
      ...base,
      type: failed ? 'payment.failed' : 'payment.succeeded',
      orderId: metadata.order_id,
      tenantId: metadata.tenant_id,
      externalOrderId: session.id,
      amount,
      currency,
      // Only settlement evidence, not card/customer personal data.
      raw: {
        id: parsed.id,
        type: parsed.type,
        sessionId: session.id,
        livemode: parsed.livemode,
        paymentStatus: session.payment_status,
      },
    }
  }

  async refund(_params: RefundParams): Promise<RefundResult> {
    throw new PaymentError(
      'refund_not_supported',
      'Stripe refunds require processor confirmation and ledger reconciliation; automatic refunds are not enabled.',
      409,
    )
  }
}
