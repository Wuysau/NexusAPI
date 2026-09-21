// POST /api/webhooks/payments/[provider]
//
// Inbound payment callback. This is the ONLY path that settles an order:
// a browser redirect never does. The handler is intentionally thin — all
// verification, idempotency and ledger work lives in src/lib/orders/webhook.ts
// so it can be tested and reused without HTTP.
//
// Responses:
//   200  processed / already processed (idempotent, so the provider stops
//        retrying)
//   400  malformed or amount-mismatched event
//   401  signature/timestamp verification failed (forgery, replay)
//   404  unknown provider or order
//   500  transient processing failure (provider should retry)

import { processPaymentWebhook } from '@/lib/orders'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await context.params
  return processPaymentWebhook(provider, req)
}
