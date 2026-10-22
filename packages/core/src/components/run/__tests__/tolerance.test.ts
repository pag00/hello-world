import { describe, expect, it } from 'vitest'
import { barGeometry, evaluateMeasurement, toleranceOf } from '../tolerance'
import { renderMarkdown } from '../markdown'

const TORQUE = { min: '11.5', nominal: '12.0', max: '12.5', decimals: 1 }

describe('evaluateMeasurement', () => {
  it('classifies with inclusive bounds and exact decimals', () => {
    expect(evaluateMeasurement('', TORQUE)).toEqual({ state: 'empty', value: null })
    expect(evaluateMeasurement('12', TORQUE)).toEqual({ state: 'in', value: '12.0' })
    expect(evaluateMeasurement('11.5', TORQUE)).toEqual({ state: 'in', value: '11.5' })
    expect(evaluateMeasurement('12.50', TORQUE)).toEqual({ state: 'in', value: '12.5' })
    expect(evaluateMeasurement('11.4', TORQUE)).toEqual({ state: 'low', value: '11.4' })
    expect(evaluateMeasurement('12.6', TORQUE)).toEqual({ state: 'high', value: '12.6' })
    expect(evaluateMeasurement('12,1', TORQUE)).toEqual({ state: 'in', value: '12.1' })
  })

  it('never rounds and rejects garbage', () => {
    expect(evaluateMeasurement('12.04', TORQUE)).toEqual({ state: 'too_many_decimals', value: null })
    expect(evaluateMeasurement('1e3', TORQUE)).toEqual({ state: 'invalid', value: null })
    expect(evaluateMeasurement('abc', TORQUE)).toEqual({ state: 'invalid', value: null })
  })

  it('missing bounds are unbounded', () => {
    expect(evaluateMeasurement('-999', { min: null, max: '1', decimals: 0 }).state).toBe('in')
    expect(evaluateMeasurement('999', { min: '0', max: null, decimals: 0 }).state).toBe('in')
    expect(toleranceOf('0.1', { min: '0.10', max: '0.20' })).toBe('in')
  })
})

describe('barGeometry', () => {
  it('places band, nominal and marker; clamps values beyond the track', () => {
    const g = barGeometry(TORQUE, '12.0')!
    expect(g.min).toBeCloseTo(1 / 6)
    expect(g.max).toBeCloseTo(5 / 6)
    expect(g.nominal).toBeCloseTo(0.5)
    expect(g.marker).toBeCloseTo(0.5)
    expect(g.clamped).toBeNull()
    expect(barGeometry(TORQUE, '20')).toMatchObject({ marker: 1, clamped: 'high' })
    expect(barGeometry(TORQUE, '0')).toMatchObject({ marker: 0, clamped: 'low' })
    expect(barGeometry(TORQUE, null)!.marker).toBeNull()
  })

  it('needs both limits', () => {
    expect(barGeometry({ min: '1', max: null, nominal: null }, '2')).toBeNull()
    expect(barGeometry({ min: '2', max: '1', nominal: null }, '2')).toBeNull()
  })
})

describe('renderMarkdown', () => {
  it('renders markdown and strips script', () => {
    const html = renderMarkdown('**Torque** to spec\n\n<script>alert(1)</script><img src=x onerror="alert(1)">\n\nSee [doc](https://x.test)')
    expect(html).toContain('<strong>Torque</strong>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).toContain('target="_blank"')
    expect(renderMarkdown('  ')).toBe('')
  })
})
