// Turn noisy OCR text from a gauge/display photo into decimal-string candidates.
// The result is only ever a proposal: the operator confirms or corrects it, so the parser prefers
// returning several plausible readings over silently guessing. It never rounds (see toFixedDecimals).

import type { DecimalString } from '../../domain/types'
import type { OcrResult } from '../types'
import { toFixedDecimals } from '../../domain/decimal'

/** Characters OCR engines (and 7-segment displays in particular) confuse with digits. */
const CONFUSABLE: Readonly<Record<string, string>> = {
  O: '0', o: '0', D: '0', Q: '0',
  I: '1', l: '1', '|': '1',
  S: '5', s: '5',
  B: '8',
  Z: '2', z: '2',
  b: '6', G: '6',
  q: '9',
}
const CONF_CLASS = 'OoDQIl|SsBZzbGq'
const NUMISH = `0-9${CONF_CLASS.replace('|', '\\|')}`

/**
 * Units stripped when they follow a number. Longest first so "mbar" wins over "bar", "kg" over "g".
 * Single letters that are also digit look-alikes (S, B, …) are deliberately absent.
 */
const UNITS = [
  'ft·lbf', 'ft-lbf', 'ft-lb', 'in-lb', 'in·lb', 'lbf·ft', 'lbf·in', 'N·m', 'N.m', 'Nm', 'cNm', 'kNm', 'mNm',
  'mbar', 'bar', 'psi', 'kPa', 'MPa', 'hPa', 'Pa',
  'µm', 'μm', 'um', 'mm', 'cm', 'dm', 'km', 'm', 'inch', 'in', 'ft', 'thou', 'mil',
  'kN', 'mN', 'N', 'lbf', 'lbs', 'lb', 'ozf', 'oz',
  'kg', 'mg', 'g',
  '°C', '°F', 'degC', 'degF', 'deg', '°', 'K',
  'mV', 'kV', 'V', 'mA', 'µA', 'A', 'kΩ', 'MΩ', 'mΩ', 'Ω', 'ohm', 'ohms',
  'rpm', 'kHz', 'MHz', 'Hz', 'ms', 'min', 'sec', 'h',
  'mL', 'ml', 'L', '%', '‰',
]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface OcrCandidate {
  /** decimal string as read (minimal integer part, fraction digits kept), e.g. "12.50" */
  value: DecimalString
  /** fraction digits as read */
  decimals: number
  /** number of look-alike characters that were mapped to digits */
  substitutions: number
  /** decimal point was inserted (7-segment displays often lose it) or separator re-interpreted */
  inferred: boolean
  /** count of digits; longer readings are more likely the main value than stray marks */
  digits: number
  /** position of the source token; earlier wins ties */
  index: number
}

export interface ParseOptions {
  /** expected fraction digits of the input (NumberInput.decimals) */
  decimals?: number
  /** unit of the input, stripped first (e.g. "Nm") */
  unit?: string
}

/** Remove unit annotations that directly follow a number (with at most one space). */
export function stripUnits(text: string, unit?: string): string {
  const units = [...(unit ? [unit] : []), ...UNITS].filter(Boolean).sort((a, b) => b.length - a.length)
  let s = text
  for (const u of units) {
    // a unit is only a unit after something number-like, and not the start of a longer word
    const re = new RegExp(`(?<=[${NUMISH}.,]\\s?)${escapeRe(u)}(?![A-Za-zÀ-ž])`, 'g')
    s = s.replace(re, ' ')
  }
  return s
}

/** Normalise dashes/minus signs and glue "12 . 5", "- 3" style splits back together. */
function preprocess(raw: string): string {
  let s = raw.normalize('NFKC')
  s = s.replace(/[−‐‑‒–—﹣－]/g, '-')
  // apostrophe / thin-space thousands separators: 1'234.5 → 1234.5
  s = s.replace(new RegExp(`(?<=[${NUMISH}])['’  ](?=[${NUMISH}]{3})`, 'g'), '')
  s = s.replace(new RegExp(`(?<=[${NUMISH}])\\s+([.,])\\s*(?=[${NUMISH}])`, 'g'), '$1')
  s = s.replace(new RegExp(`(?<=[${NUMISH}])([.,])\\s+(?=[0-9])`, 'g'), '$1')
  s = s.replace(new RegExp(`(^|\\s)([-+])\\s+(?=[${NUMISH}.,])`, 'g'), '$1$2')
  return s
}

function stripLeadingZeros(intPart: string): string {
  const t = intPart.replace(/^0+(?=\d)/, '')
  return t === '' ? '0' : t
}

function build(neg: boolean, intPart: string, frac: string | null): string {
  const i = stripLeadingZeros(intPart || '0')
  const body = frac !== null && frac !== '' ? `${i}.${frac}` : i
  // "-0" / "-0.00" keep the sign only when non-zero; a displayed "-0.00" is still zero
  const zero = /^0(\.0*)?$/.test(body)
  return neg && !zero ? `-${body}` : body
}

interface TokenReading {
  value: string
  decimals: number
  inferred: boolean
}

/** Interpret separators in an already digit-mapped token: "1.234,5", "12,50", "1,234,567". */
function readSeparators(neg: boolean, tok: string): TokenReading[] {
  const seps = tok.match(/[.,]/g) ?? []
  if (seps.length === 0) return [{ value: build(neg, tok, null), decimals: 0, inferred: false }]
  const hasDot = tok.includes('.')
  const hasComma = tok.includes(',')
  if (hasDot && hasComma) {
    // the last separator is the decimal mark, the others group thousands
    const last = Math.max(tok.lastIndexOf('.'), tok.lastIndexOf(','))
    const intPart = tok.slice(0, last).replace(/[.,]/g, '')
    const frac = tok.slice(last + 1)
    if (!/^\d*$/.test(intPart) || !/^\d*$/.test(frac)) return []
    return [{ value: build(neg, intPart, frac), decimals: frac.length, inferred: false }]
  }
  const parts = tok.split(/[.,]/)
  if (parts.length > 2) {
    // only a well-formed grouping is believable: 1,234,567
    if (/^\d{1,3}$/.test(parts[0]!) && parts.slice(1).every((p) => /^\d{3}$/.test(p))) {
      return [{ value: build(neg, parts.join(''), null), decimals: 0, inferred: true }]
    }
    return []
  }
  const [intPart = '', frac = ''] = parts
  if (intPart === '' && frac === '') return []
  const out: TokenReading[] = [{ value: build(neg, intPart, frac), decimals: frac.length, inferred: false }]
  // "1,234" may be a thousands group rather than a decimal comma; offer it, ranked lower
  if (/^\d{1,3}$/.test(intPart) && /^\d{3}$/.test(frac) && intPart !== '0') {
    out.push({ value: build(neg, intPart + frac, null), decimals: 0, inferred: true })
  }
  return out
}

/** All numeric readings in the text, in reading order, before ranking. */
export function extractCandidates(raw: string, opts: ParseOptions = {}): OcrCandidate[] {
  const text = preprocess(stripUnits(preprocess(raw), opts.unit))
  const tokens = text.split(/[\s:;=/\\()[\]{}<>"“”«»*#~_]+/).filter((t) => t !== '')
  const tokenRe = new RegExp(`^[${NUMISH}.,]+$`)
  const out: OcrCandidate[] = []
  const soleToken = tokens.length === 1

  tokens.forEach((original, index) => {
    let tok = original
    let neg = false
    const sign = /^([-+]+)/.exec(tok)
    if (sign) {
      neg = sign[1]!.includes('-')
      tok = tok.slice(sign[1]!.length)
    }
    // a trailing run of letters/symbols is an unknown unit unless every char is a digit look-alike ("12.5O")
    const tail = /[A-Za-zÀ-žµΩ°%‰|]+$/.exec(tok)
    if (tail && [...tail[0]].some((c) => !(c in CONFUSABLE))) tok = tok.slice(0, tail.index)
    // a trailing separator carries no information ("12.5.")
    tok = tok.replace(/[.,]+$/, '').replace(/^[.,]+(?=[.,])/, '')
    if (!tok || !tokenRe.test(tok)) return
    const realDigits = (tok.match(/[0-9]/g) ?? []).length
    const subs = (tok.match(new RegExp(`[${CONF_CLASS.replace('|', '\\|')}]`, 'g')) ?? []).length
    // words like "Bob" or "Oil" are not numbers; accept pure look-alikes only when nothing else was read
    if (realDigits === 0 && !(soleToken && subs > 0 && subs <= 8)) return
    const mapped = tok.replace(/[^0-9.,]/g, (c) => CONFUSABLE[c] ?? c)
    if (!/\d/.test(mapped)) return

    for (const r of readSeparators(neg, mapped)) {
      const digits = (r.value.match(/\d/g) ?? []).length
      out.push({ value: r.value, decimals: r.decimals, substitutions: subs, inferred: r.inferred, digits, index })
    }

    // 7-segment displays: the decimal point is often too small for OCR. Offer the implied position.
    const d = opts.decimals
    if (d && d > 0 && !/[.,]/.test(mapped)) {
      const plain = mapped
      if (plain.length > d) {
        const v = build(neg, plain.slice(0, plain.length - d), plain.slice(plain.length - d))
        out.push({ value: v, decimals: d, substitutions: subs, inferred: true, digits: plain.length, index })
      }
    }
  })
  return out
}

/** Higher is better. Exported for tests only. */
export function scoreCandidate(c: OcrCandidate, decimals?: number): number {
  let s = 0
  if (decimals !== undefined) {
    if (c.decimals === decimals) s += 3
    else if (c.decimals < decimals) s += 2 // exact zero padding, no information invented
    else if (toFixedDecimals(c.value, decimals).ok) s += 1 // only trailing zeros beyond
    else s += 0.5 // literal but unusable as is: still ranked above anything we had to infer
  }
  if (c.inferred) s -= 2
  s -= Math.min(c.substitutions, 4) * 0.25
  s += Math.min(c.digits, 8) * 0.1
  return s
}

/** Present a candidate with the expected number of fraction digits when that is exact. */
function present(value: string, decimals?: number): DecimalString {
  if (decimals === undefined) return value
  const r = toFixedDecimals(value, decimals)
  return r.ok ? r.value : value
}

/**
 * Parse recognised text into an OcrResult.
 * @param engineConfidence 0..1 confidence reported by the OCR engine for the text
 */
export function parseOcrNumber(raw: string, opts: ParseOptions = {}, engineConfidence = 1): OcrResult {
  const decimals = opts.decimals !== undefined && Number.isInteger(opts.decimals) && opts.decimals >= 0 ? opts.decimals : undefined
  const found = extractCandidates(raw, { ...opts, decimals })
  const ranked = found
    .map((c) => ({ c, s: scoreCandidate(c, decimals) }))
    .sort((a, b) => b.s - a.s || a.c.index - b.c.index)

  const candidates: DecimalString[] = []
  for (const { c } of ranked) {
    const v = present(c.value, decimals)
    if (!candidates.includes(v)) candidates.push(v)
  }
  const best = ranked[0]?.c
  if (!best) return { raw, value: null, confidence: 0, candidates: [] }

  let q = 1
  if (decimals !== undefined && best.decimals !== decimals) q *= best.decimals < decimals ? 0.9 : 0.6
  if (best.substitutions > 0) q *= 0.85
  if (best.inferred) q *= 0.6
  if (candidates.length > 1) q *= 0.8
  const engine = Number.isFinite(engineConfidence) ? Math.min(1, Math.max(0, engineConfidence)) : 0
  const confidence = Math.round(engine * q * 100) / 100
  return { raw, value: candidates[0]!, confidence, candidates }
}
