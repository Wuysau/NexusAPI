// Browser-safe purchase policy. A missing/expired hosted URL says nothing
// about whether money moved. Only a terminal server order permits a new key.
export function canReleasePurchaseKey(status: string): boolean {
  return ['paid', 'failed', 'cancelled', 'refunded'].includes(status)
}
