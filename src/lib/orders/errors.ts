export type OrderErrorCode =
  | 'invalid_input'
  | 'tenant_not_found'
  | 'order_not_found'
  | 'plan_version_not_found'
  | 'plan_version_not_published'
  | 'amount_mismatch'
  | 'duplicate_refund'
  | 'order_not_refundable'
  | 'missing_original_transaction'
  | 'duplicate_idempotency_key'
  | 'payment_provider_error'

export class OrderError extends Error {
  readonly status: number
  readonly code: OrderErrorCode

  constructor(code: OrderErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'OrderError'
    this.code = code
    this.status = status
  }
}
