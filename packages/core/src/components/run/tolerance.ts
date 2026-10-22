// Live tolerance evaluation for number inputs. Decisions use exact decimal comparison (same rule as the
// projection: bounds inclusive, missing bound = unbounded); Number is only used to place the bar marker.
import { compareDecimal, isDecimal, toFixedDecimals } from '../../domain/decimal'
import type { NumberInput } from '../../domain/types'

export type ToleranceState = 'empty' | 'invalid' | 'too_many_decimals' | 'in' | 'low' | 'high'

export interface Measurement {
  state: ToleranceState
  /** normalized to input.decimals when parseable */
  value: string | null
}

type Limits = Pick<NumberInput, 'min' | 'max'>

export function toleranceOf(value: string, input: Limits): 'in' | 'low' | 'high' {
  if (input.min != null && isDecimal(input.min) && compareDecimal(value, input.min) < 0) return 'low'
  if (input.max != null && isDecimal(input.max) && compareDecimal(value, input.max) > 0) return 'high'
  return 'in'
}

export function evaluateMeasurement(raw: string, input: Limits & Pick<NumberInput, 'decimals'>): Measurement {
  if (!raw.trim()) return { state: 'empty', value: null }
  const r = toFixedDecimals(raw, input.decimals)
  if (!r.ok) return { state: r.error === 'too_many_decimals' ? 'too_many_decimals' : 'invalid', value: null }
  return { state: toleranceOf(r.value, input), value: r.value }
}

export interface BarGeometry {
  /** 0..1 positions on the track */
  min: number
  max: number
  nominal: number | null
  marker: number | null
  /** marker clamped at a track end because the value lies beyond the displayed range */
  clamped: 'low' | 'high' | null
}

/** Track spans the tolerance band plus 25 % margin each side; only drawn when both limits exist. */
export function barGeometry(input: Pick<NumberInput, 'min' | 'max' | 'nominal'>, value: string | null): BarGeometry | null {
  if (input.min == null || input.max == null || !isDecimal(input.min) || !isDecimal(input.max)) return null
  const lo = Number(input.min)
  const hi = Number(input.max)
  if (!(hi > lo)) return null
  const margin = (hi - lo) * 0.25
  const start = lo - margin
  const span = hi - lo + 2 * margin
  const pos = (x: number) => (x - start) / span
  let marker: number | null = null
  let clamped: BarGeometry['clamped'] = null
  if (value != null && isDecimal(value)) {
    const p = pos(Number(value))
    if (p < 0) clamped = 'low'
    else if (p > 1) clamped = 'high'
    marker = Math.min(1, Math.max(0, p))
  }
  const nominal = input.nominal != null && isDecimal(input.nominal) ? Math.min(1, Math.max(0, pos(Number(input.nominal)))) : null
  return { min: pos(lo), max: pos(hi), nominal, marker, clamped }
}
