// Money handling. All settled amounts are integer "micros": 1e-6 of a currency
// unit, stored as bigint. This module is the ONLY place that converts between
// human amounts and micros. Never use JS number for money arithmetic.
//
// Provider price RATES arrive as numeric strings (e.g. "2.50" USD per 1M
// tokens). They are not money until multiplied by a quantity and rounded to
// micros. See priceToMicros() and charge().

export type Micros = bigint
export const MICROS_PER_UNIT = 1_000_000n

/** Decimal-string → micros. Throws on invalid input (no silent float coercion). */
export function toMicros(decimal: string | number | null | undefined): Micros {
  if (decimal === null || decimal === undefined || decimal === '') throw new Error('money: empty amount')
  const s = typeof decimal === 'number' ? decimal.toString() : decimal.trim()
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`money: invalid amount "${decimal}"`)
  const neg = s.startsWith('-')
  const [intPart, frac = ''] = (neg ? s.slice(1) : s).split('.')
  const fracPadded = (frac + '000000').slice(0, 6)
  const v = BigInt(intPart) * MICROS_PER_UNIT + BigInt(fracPadded)
  return neg ? -v : v
}

/** Micros → fixed decimal string with 6 places (e.g. "1.234567"). */
export function fromMicros(m: Micros): string {
  const neg = m < 0n
  const a = neg ? -m : m
  const intPart = a / MICROS_PER_UNIT
  const frac = a % MICROS_PER_UNIT
  const fracStr = frac.toString().padStart(6, '0')
  return `${neg ? '-' : ''}${intPart}.${fracStr}`
}

/** Human-friendly display string, 2 decimal places, currency symbol optional. */
export function formatMicros(m: Micros, currency?: string): string {
  const neg = m < 0n
  const a = neg ? -m : m
  const cents = (a + 5000n) / 10000n // micros → cents, rounded half-up
  const intPart = cents / 100n
  const frac = cents % 100n
  const s = `${intPart}.${frac.toString().padStart(2, '0')}`
  const sign = neg ? '-' : ''
  return currency ? `${sign}${currencySymbol(currency)}${s}` : `${sign}${s}`
}

function currencySymbol(c: string): string {
  return c === 'USD' ? '$' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : c === 'CNY' || c === 'RMB' ? '¥' : `${c} `
}

/** Parse a decimal string into an exact fraction {num, den}, value = num/den. */
export function parseDecimal(s: string | number): { num: bigint; den: bigint } {
  const str = typeof s === 'number' ? s.toString() : s.trim()
  if (!/^-?\d+(\.\d+)?$/.test(str)) throw new Error(`money: invalid amount "${s}"`)
  const neg = str.startsWith('-')
  const [ip, fp = ''] = (neg ? str.slice(1) : str).split('.')
  return { num: (neg ? -1n : 1n) * BigInt(ip + fp || '0'), den: 10n ** BigInt(fp.length) }
}

export function addMicros(a: Micros, b: Micros): Micros {
  return a + b
}
export function subMicros(a: Micros, b: Micros): Micros {
  return a - b
}

/**
 * Convert a per-unit provider price (numeric string) × token count → charge
 * micros, using EXACT integer arithmetic (no pre-truncation of the rate).
 * pricePerUnit is currency per 1 unit; unitScale is how many tokens make one
 * "unit" (1_000_000 for "per million tokens", 1 for "per token").
 *
 *   micros = pricePerUnit × tokens / unitScale × 1e6
 *           = (num/den) × tokens × 1e6 / unitScale
 */
export function charge(pricePerUnit: string, tokenCount: number, unitScale: number): Micros {
  const { num, den } = parseDecimal(pricePerUnit)
  const tokens = BigInt(Math.max(0, Math.floor(tokenCount)))
  const scale = BigInt(unitScale)
  return (num * tokens * MICROS_PER_UNIT) / (den * scale)
}
