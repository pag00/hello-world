import { describe, expect, it } from 'vitest'
import { compareDecimal, hasExactDecimals, isDecimal, normalizeDecimal, parseDecimal, toFixedDecimals } from '../../src/domain/decimal'
import { isOutOfTolerance } from '../../src/domain/limits'

describe('decimal', () => {
  it('parses only plain decimals', () => {
    for (const ok of ['0', '12.5', '-0.25', '+3', '.5', '7.', '000012.5000']) expect(isDecimal(ok), ok).toBe(true)
    for (const bad of ['', '.', '-', '1e3', '1,5', ' 1', '0x10', 'NaN', 'Infinity', '1.2.3', '--1']) expect(isDecimal(bad), bad).toBe(false)
    expect(parseDecimal('12.50')).toEqual({ units: 1250n, scale: 2 })
  })

  it('compares exactly regardless of trailing zeros and scale', () => {
    expect(compareDecimal('12.50', '12.5')).toBe(0)
    expect(compareDecimal('12.5', '12.49999999999999999999')).toBe(1)
    expect(compareDecimal('-0.0', '0')).toBe(0)
    expect(compareDecimal('-1.5', '-1.25')).toBe(-1)
    // beyond double precision
    expect(compareDecimal('9007199254740993', '9007199254740992')).toBe(1)
    expect(compareDecimal('0.3', '0.30000000000000004')).toBe(-1)
    expect(() => compareDecimal('abc', '1')).toThrow()
  })

  it('normalizes to the minimal form', () => {
    expect(normalizeDecimal('+0012.5000')).toBe('12.5')
    expect(normalizeDecimal('-0.000')).toBe('0')
    expect(normalizeDecimal('.5')).toBe('0.5')
    expect(normalizeDecimal('-7.')).toBe('-7')
    expect(normalizeDecimal('-0.050')).toBe('-0.05')
  })

  it('fixes input to the declared decimals without rounding', () => {
    expect(toFixedDecimals('12', 1)).toEqual({ ok: true, value: '12.0' })
    expect(toFixedDecimals(' 12,5 ', 2)).toEqual({ ok: true, value: '12.50' })
    expect(toFixedDecimals('12.500', 1)).toEqual({ ok: true, value: '12.5' })
    expect(toFixedDecimals('12.55', 1)).toEqual({ ok: false, error: 'too_many_decimals' })
    expect(toFixedDecimals('-0.04', 1)).toEqual({ ok: false, error: 'too_many_decimals' })
    expect(toFixedDecimals('-0', 2)).toEqual({ ok: true, value: '0.00' })
    expect(toFixedDecimals('-.5', 1)).toEqual({ ok: true, value: '-0.5' })
    expect(toFixedDecimals('7', 0)).toEqual({ ok: true, value: '7' })
    expect(toFixedDecimals('abc', 1)).toEqual({ ok: false, error: 'invalid' })
    expect(hasExactDecimals('12.0', 1)).toBe(true)
    expect(hasExactDecimals('12', 1)).toBe(false)
    expect(hasExactDecimals('012.0', 1)).toBe(false)
  })

  it('tolerance: inclusive bounds, missing bound unbounded, garbage is out', () => {
    const lim = { min: '11.5', max: '12.5' }
    expect(isOutOfTolerance('11.5', lim)).toBe(false)
    expect(isOutOfTolerance('12.50', lim)).toBe(false)
    expect(isOutOfTolerance('12.51', lim)).toBe(true)
    expect(isOutOfTolerance('11.49', lim)).toBe(true)
    expect(isOutOfTolerance('1000', { min: '0' })).toBe(false)
    expect(isOutOfTolerance('-1000', { max: '0', min: null })).toBe(false)
    expect(isOutOfTolerance('x', {})).toBe(true)
    expect(isOutOfTolerance(true, {})).toBe(true)
  })
})
