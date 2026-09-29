import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StripePaymentProvider, microsToMinorUnits, stripeConfiguration } from './stripe'

const config = {
  secretKey: 'sk_test_fixture',
  webhookSecret: 'whsec_fixture',
  mode: 'test' as const,
  origin: 'https://nexus.example',
}
const event = () => ({
  id: 'evt_fixture',
  type: 'checkout.session.completed',
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  data: {
    object: {
      object: 'checkout.session',
      id: 'cs_test_fixture',
      mode: 'payment',
      status: 'complete',
      payment_status: 'paid',
      livemode: false,
      amount_total: 1200,
      currency: 'usd',
      client_reference_id: 'order-1',
      metadata: { order_id: 'order-1', tenant_id: 'tenant-1' },
    },
  },
})
function signed(body: string, timestamp = Math.floor(Date.now() / 1000), signature?: string) {
  const hash = createHmac('sha256', config.webhookSecret).update(`${timestamp}.${body}`).digest('hex')
  return new Request('https://nexus.example/api/webhooks/payments/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': `t=${timestamp},v1=${signature ?? hash}` },
    body,
  })
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
describe('Stripe money and configuration', () => {
  it('converts only exact, positive, supported currency amounts', () => {
    expect(microsToMinorUnits(12_340_000n, 'USD')).toBe(1234)
    expect(microsToMinorUnits(12_000_000n, 'JPY')).toBe(12)
    for (const [amount, currency] of [
      [1n, 'USD'],
      [0n, 'USD'],
      [-10000n, 'USD'],
      [1_000_000n, 'XYZ'],
      [1_001_000n, 'JPY'],
      [1_000_000_000_000n, 'USD'],
    ] as const)
      expect(() => microsToMinorUnits(amount, currency)).toThrow()
  })
  it('fails closed on absent config and mismatched test/live key', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(stripeConfiguration().configured).toBe(false)
    expect(() => new StripePaymentProvider({ ...config, mode: 'live' })).toThrow()
    expect(() => new StripePaymentProvider({ ...config, origin: 'http://merchant.example' })).toThrow()
  })
})
describe('Stripe raw-body webhook contract', () => {
  it('requires one timestamp but accepts a valid v1 signature alongside rotated signatures', async () => {
    const raw = JSON.stringify(event())
    const valid = signed(raw)
    const provider = new StripePaymentProvider(config)
    const header = valid.headers.get('stripe-signature')!
    const make = (signature: string) =>
      new Request(valid.url, { method: 'POST', headers: { 'stripe-signature': signature }, body: raw })
    expect((await provider.verifyWebhook(make(`${header},v1=${'0'.repeat(64)}`))).type).toBe('payment.succeeded')
    await expect(provider.verifyWebhook(make(`${header},t=123`))).rejects.toMatchObject({ code: 'invalid_signature' })
    await expect(provider.verifyWebhook(make('t=NaN,v1=ab'))).rejects.toMatchObject({ code: 'invalid_signature' })
    await expect(provider.verifyWebhook(new Request(valid.url, { method: 'POST', body: raw }))).rejects.toMatchObject({
      code: 'missing_signature',
    })
  })
  it('bounds streaming webhook bodies before allocating the full input', async () => {
    const cancel = vi.fn()
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulls > 3) controller.close()
        else controller.enqueue(new Uint8Array(600_000))
      },
      cancel,
    })
    const request = new Request('https://nexus.example/webhook', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit)
    await expect(new StripePaymentProvider(config).verifyWebhook(request)).rejects.toMatchObject({ status: 413 })
    expect(cancel).toHaveBeenCalled()
  })
  it('verifies a paid Checkout session and exact amount/tenant binding', async () => {
    const verified = await new StripePaymentProvider(config).verifyWebhook(signed(JSON.stringify(event())))
    expect(verified).toMatchObject({
      provider: 'stripe',
      orderId: 'order-1',
      tenantId: 'tenant-1',
      externalOrderId: 'cs_test_fixture',
      amount: 12_000_000n,
      currency: 'USD',
      type: 'payment.succeeded',
    })
  })
  it('rejects forged, stale, future and malformed signed bodies', async () => {
    const provider = new StripePaymentProvider(config)
    await expect(
      provider.verifyWebhook(signed(JSON.stringify(event()), undefined, '0'.repeat(64))),
    ).rejects.toMatchObject({ code: 'invalid_signature' })
    for (const offset of [-301, 301])
      await expect(
        provider.verifyWebhook(signed(JSON.stringify(event()), Math.floor(Date.now() / 1000) + offset)),
      ).rejects.toMatchObject({ code: 'timestamp_out_of_window' })
    for (const body of ['{', 'null', '{}', JSON.stringify({ ...event(), data: null })])
      await expect(provider.verifyWebhook(signed(body))).rejects.toMatchObject({ code: 'malformed_event' })
  })
  it('does not accept reserialized bytes, wrong mode, fractional amounts or foreign order metadata', async () => {
    const provider = new StripePaymentProvider(config)
    const payload = event()
    for (const change of [
      { livemode: true },
      { amount_total: 1.5 },
      { client_reference_id: 'other' },
      { currency: 'XYZ' },
      { metadata: { order_id: 'order-1' } },
    ]) {
      const changed = { ...payload, data: { object: { ...payload.data.object, ...change } } }
      await expect(provider.verifyWebhook(signed(JSON.stringify(changed)))).rejects.toThrow()
    }
    const raw = JSON.stringify(payload)
    const request = signed(raw)
    await expect(
      provider.verifyWebhook(new Request(request.url, { method: 'POST', headers: request.headers, body: `${raw} ` })),
    ).rejects.toMatchObject({ code: 'invalid_signature' })
  })
  it('ignores unpaid completion and unrelated verified event types', async () => {
    const payload = event()
    payload.data.object.payment_status = 'unpaid'
    expect((await new StripePaymentProvider(config).verifyWebhook(signed(JSON.stringify(payload)))).type).toBe(
      'ignored',
    )
    expect(
      (
        await new StripePaymentProvider(config).verifyWebhook(
          signed(JSON.stringify({ ...event(), type: 'charge.updated' })),
        )
      ).type,
    ).toBe('ignored')
  })
})
describe('Stripe checkout', () => {
  it('sends exact server amount and deterministic idempotency; never marks paid', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        id: 'cs_test_fixture',
        url: 'https://checkout.stripe.com/c/pay/cs_test_fixture',
        livemode: false,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        amount_total: 1200,
        currency: 'usd',
        client_reference_id: 'order-1',
        metadata: { order_id: 'order-1', tenant_id: 'tenant-1' },
      }),
    )
    const provider = new StripePaymentProvider(config)
    const params = { orderId: 'order-1', amount: 12_000_000n, currency: 'USD', tenantId: 'tenant-1' }
    const result = await provider.createCheckout(params)
    expect(result).toMatchObject({ status: 'created', sandbox: true, confirmation: 'webhook_only' })
    const init = fetchMock.mock.calls[0][1]!
    expect(new Headers(init.headers).get('idempotency-key')).toBe('nexus-checkout:order-1')
    const body = new URLSearchParams(String(init.body))
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('1200')
    expect(body.get('metadata[tenant_id]')).toBe('tenant-1')
    expect(body.get('success_url')).toBe('https://nexus.example/billing?checkout=returned')
  })
  it('refuses unsupported refunds and hides processor errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: { message: 'secret diagnostic' } }, { status: 400 }),
    )
    const provider = new StripePaymentProvider(config)
    await expect(
      provider.createCheckout({ orderId: 'order-1', amount: 1_000_000n, currency: 'USD', tenantId: 'tenant-1' }),
    ).rejects.toMatchObject({
      code: 'processor_error',
      message: 'Stripe checkout could not be created. Retry the same order.',
    })
    await expect(provider.refund({ originalTransactionId: 'tx', amount: 1n, reason: 'test' })).rejects.toMatchObject({
      code: 'refund_not_supported',
    })
  })
})
