// Exact decimal-string arithmetic for measured values and limits. Never goes through Number:
// "12.50" vs "12.5" must compare equal and 0.1+0.2 style errors must be impossible.

import type { DecimalString } from './types'

export interface ParsedDecimal {
  /** unscaled value: 12.50 → 1250n with scale 2 */
  units: bigint
  scale: number
}

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?$/

/** Parse "12.5", "-0.25", "+3", ".5", "7." — returns null for anything else (no exponents, no spaces). */
export function parseDecimal(s: string): ParsedDecimal | null {
  if (typeof s !== 'string') return null
  const m = DECIMAL_RE.exec(s)
  if (!m) return null
  const sign = m[1] === '-' ? -1n : 1n
  const intPart = m[2] ?? ''
  const fracPart = m[3] ?? ''
  if (intPart === '' && fracPart === '') return null
  const digits = (intPart || '0') + fracPart
  return { units: sign * BigInt(digits), scale: fracPart.length }
}

export function isDecimal(s: unknown): s is DecimalString {
  return typeof s === 'string' && parseDecimal(s) !== null
}

function rescale(d: ParsedDecimal, scale: number): bigint {
  return d.units * 10n ** BigInt(scale - d.scale)
}

/** -1 / 0 / 1. Throws on malformed input — callers decide how to treat garbage. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const pa = parseDecimal(a)
  const pb = parseDecimal(b)
  if (!pa || !pb) throw new Error(`not a decimal: ${!pa ? a : b}`)
  const scale = Math.max(pa.scale, pb.scale)
  const x = rescale(pa, scale)
  const y = rescale(pb, scale)
  return x < y ? -1 : x > y ? 1 : 0
}

function format(units: bigint, scale: number): string {
  const neg = units < 0n
  let digits = (neg ? -units : units).toString()
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0')
    digits = digits.slice(0, -scale) + '.' + digits.slice(-scale)
  }
  return (neg ? '-' : '') + digits
}

/** Canonical minimal form: no '+', no leading zeros, no trailing fraction zeros, "-0" → "0". */
export function normalizeDecimal(s: string): DecimalString {
  const p = parseDecimal(s)
  if (!p) throw new Error(`not a decimal: ${s}`)
  let { units, scale } = p
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n
    scale--
  }
  return format(units, scale)
}

export type FixedResult = { ok: true; value: DecimalString } | { ok: false; error: 'invalid' | 'too_many_decimals' }

/**
 * Bring user/OCR input to exactly `decimals` fraction digits. Accepts a comma as decimal separator
 * (German keypads) and surrounding whitespace. Pads with zeros; never rounds — extra non-zero digits
 * are an error, because silently rounding a measurement would falsify the record.
 */
export function toFixedDecimals(input: string, decimals: number): FixedResult {
  const cleaned = input.trim().replace(',', '.')
  const p = parseDecimal(cleaned)
  if (!p || !Number.isInteger(decimals) || decimals < 0) return { ok: false, error: 'invalid' }
  let { units, scale } = p
  while (scale > decimals) {
    if (units % 10n !== 0n) return { ok: false, error: 'too_many_decimals' }
    units /= 10n
    scale--
  }
  return { ok: true, value: format(rescale({ units, scale }, decimals), decimals) }
}

/** True when `s` already has exactly `decimals` fraction digits in canonical form. */
export function hasExactDecimals(s: string, decimals: number): boolean {
  const r = toFixedDecimals(s, decimals)
  return r.ok && r.value === s
}
