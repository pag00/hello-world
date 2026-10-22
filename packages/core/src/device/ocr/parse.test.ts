import { describe, expect, it } from 'vitest'
import { extractCandidates, parseOcrNumber, scoreCandidate, stripUnits } from './parse'

const best = (raw: string, decimals?: number, unit?: string) => parseOcrNumber(raw, { decimals, unit }).value

describe('parseOcrNumber — plain readings', () => {
  it.each([
    ['12.50', 2, '12.50'],
    ['12.5', 2, '12.50'], // padding is exact, never invents digits
    ['12', 2, '12.00'],
    ['0.25', 2, '0.25'],
    ['.5', 1, '0.5'],
    ['007.5', 1, '7.5'],
    ['1234', 0, '1234'],
    ['  12.50 \n', 2, '12.50'],
  ])('%j (decimals %s) → %s', (raw, d, v) => {
    expect(best(raw, d)).toBe(v)
  })

  it('returns null and no candidates for empty or non-numeric text', () => {
    for (const raw of ['', '   ', '---', 'Torque', 'ERROR', '.', ',']) {
      const r = parseOcrNumber(raw, { decimals: 2 })
      expect(r.value, raw).toBeNull()
      expect(r.candidates, raw).toEqual([])
      expect(r.confidence).toBe(0)
    }
  })

  it('keeps the raw text untouched for the record (ocr_raw)', () => {
    const raw = ' l2,5O Nm\n'
    expect(parseOcrNumber(raw, { decimals: 2 }).raw).toBe(raw)
  })

  it('without expected decimals keeps the digits as read', () => {
    expect(best('12.50')).toBe('12.50')
    expect(best('3')).toBe('3')
  })

  it('never produces floats or exponent notation', () => {
    for (const raw of ['0.1', '1e5', '12.3456789012345678901234']) {
      const r = parseOcrNumber(raw, {})
      for (const c of r.candidates) expect(c).toMatch(/^-?\d+(\.\d+)?$/)
    }
    expect(best('12.3456789012345678901234')).toBe('12.3456789012345678901234')
  })
})

describe('parseOcrNumber — look-alike characters (7-segment and font confusions)', () => {
  it.each([
    ['12.5O', 2, '12.50'], // O → 0
    ['12.5o', 2, '12.50'], // o → 0
    ['D.25', 2, '0.25'], // D → 0 (7-segment zero)
    ['l2.50', 2, '12.50'], // l → 1
    ['I2.50', 2, '12.50'], // I → 1
    ['|2.50', 2, '12.50'], // | → 1
    ['S.75', 2, '5.75'], // S → 5
    ['1B.0', 1, '18.0'], // B → 8
    ['Z4.1', 1, '24.1'], // Z → 2
    ['1OO', 0, '100'], // several look-alikes next to one real digit
    ['b.5', 1, '6.5'], // b → 6
  ])('%j → %s', (raw, d, v) => {
    expect(best(raw, d)).toBe(v)
  })

  it('accepts a reading made only of look-alikes when it is the only thing recognised', () => {
    expect(best('OO.S', 1)).toBe('0.5')
    expect(best('lO', 0)).toBe('10')
  })

  it('does not turn words into numbers when real digits are present elsewhere', () => {
    expect(best('Bolt torque 12.5', 1)).toBe('12.5')
    expect(parseOcrNumber('Bolt torque 12.5', { decimals: 1 }).candidates).toEqual(['12.5'])
  })

  it('lowers confidence when characters had to be substituted', () => {
    const clean = parseOcrNumber('12.50', { decimals: 2 }, 0.9)
    const subst = parseOcrNumber('l2.5O', { decimals: 2 }, 0.9)
    expect(subst.value).toBe(clean.value)
    expect(subst.confidence).toBeLessThan(clean.confidence)
  })
})

describe('parseOcrNumber — separators', () => {
  it.each([
    ['12,50', 2, '12.50'], // German decimal comma
    ['12 , 50', 2, '12.50'], // split by OCR spacing
    ['12 .5', 1, '12.5'],
    ['1.234,5', 1, '1234.5'], // German thousands
    ['1,234.5', 1, '1234.5'], // English thousands
    ["1'234.5", 1, '1234.5'], // Swiss thousands
    ['1,234,567', 0, '1234567'],
    ['12.5.', 1, '12.5'], // trailing separator noise
  ])('%j → %s', (raw, d, v) => {
    expect(best(raw, d)).toBe(v)
  })

  it('treats a single comma before 3 digits as decimal when 3 decimals are expected, else offers thousands', () => {
    expect(best('1,234', 3)).toBe('1.234')
    const r = parseOcrNumber('1,234', { decimals: 0 })
    expect(r.candidates).toContain('1234')
    expect(r.candidates).toContain('1.234')
  })

  it('rejects malformed groupings instead of guessing', () => {
    expect(parseOcrNumber('1.23.4', { decimals: 1 }).value).toBeNull()
  })
})

describe('parseOcrNumber — negative values', () => {
  it.each([
    ['-0.25', 2, '-0.25'],
    ['- 0.25', 2, '-0.25'],
    ['−0.25', 2, '-0.25'], // U+2212 minus sign
    ['–1.5', 1, '-1.5'], // en dash
    ['-12,5O', 2, '-12.50'],
    ['+3.0', 1, '3.0'],
  ])('%j → %s', (raw, d, v) => {
    expect(best(raw, d)).toBe(v)
  })

  it('a displayed "-0.00" is zero, not negative zero', () => {
    expect(best('-0.00', 2)).toBe('0.00')
  })
})

describe('parseOcrNumber — units', () => {
  it.each([
    ['12.5 Nm', 1, undefined, '12.5'],
    ['12.5Nm', 1, undefined, '12.5'],
    ['0.25 mm', 2, undefined, '0.25'],
    ['3.2bar', 1, undefined, '3.2'],
    ['850 mbar', 0, undefined, '850'],
    ['21.5 °C', 1, undefined, '21.5'],
    ['21.5°C', 1, undefined, '21.5'],
    ['45 %', 0, undefined, '45'],
    ['12.0 V', 1, undefined, '12.0'],
    ['5.5 kN', 1, undefined, '5.5'],
    ['1.25 in', 2, undefined, '1.25'],
    ['30 lbf', 0, undefined, '30'], // "lbf" must not become "18f"
    ['12.5 in-lb', 1, undefined, '12.5'],
    ['8.0 ft-lbf', 1, undefined, '8.0'],
    ['12.5 cNm', 1, 'cNm', '12.5'],
    ['12.5 Ncm', 1, 'Ncm', '12.5'], // input-specific unit not in the built-in list
  ])('%j → %s', (raw, d, unit, v) => {
    expect(best(raw, d, unit)).toBe(v)
  })

  it('strips units only after a number', () => {
    expect(stripUnits('mm 12.5mm')).toBe('mm 12.5 ')
    expect(stripUnits('Admin 4 min')).toBe('Admin 4  ')
  })

  it('a unit glyph that is also a look-alike stays a digit when no unit is expected', () => {
    // "S" is not treated as a unit (Siemens is rare, S→5 is common)
    expect(best('12.S', 1)).toBe('12.5')
  })

  it('strips trailing unknown unit letters', () => {
    expect(best('12.5xyz', 1)).toBe('12.5')
    expect(best('12.5V', 1)).toBe('12.5')
    expect(best('12.5O', 2)).toBe('12.50') // all look-alikes: digits, not a unit
  })
})

describe('parseOcrNumber — choosing between candidates', () => {
  it('prefers the reading with the expected number of decimals', () => {
    const r = parseOcrNumber('3 12.50', { decimals: 2 })
    expect(r.value).toBe('12.50')
    expect(r.candidates).toEqual(['12.50', '3.00'])
  })

  it('prefers the longer reading over stray marks when decimals tie', () => {
    expect(best('1 1250', 0)).toBe('1250')
  })

  it('offers an implied decimal point for 7-segment displays, ranked below the literal reading', () => {
    const r = parseOcrNumber('1250', { decimals: 2 })
    expect(r.value).toBe('1250.00')
    expect(r.candidates).toEqual(['1250.00', '12.50'])
  })

  it('implied decimal keeps the sign and leading zero', () => {
    const r = parseOcrNumber('-025', { decimals: 2 })
    expect(r.candidates).toContain('-0.25')
  })

  it('a reading with more decimals than allowed is never rounded', () => {
    const r = parseOcrNumber('12.345', { decimals: 2 })
    expect(r.value).toBe('12.345') // shown as read; the UI blocks confirming it
    expect(r.candidates).toEqual(['12.345', '12345.00'])
    expect(r.confidence).toBeLessThan(0.7)
  })

  it('trailing zeros beyond the expected decimals are dropped exactly', () => {
    expect(best('12.500', 2)).toBe('12.50')
  })

  it('earlier readings win exact ties', () => {
    expect(parseOcrNumber('12.5 13.5', { decimals: 1 }).value).toBe('12.5')
  })

  it('deduplicates equal candidates', () => {
    const r = parseOcrNumber('12.5 12.50', { decimals: 2 })
    expect(r.candidates).toEqual(['12.50'])
  })

  it('ignores invalid decimals options', () => {
    expect(parseOcrNumber('12.5', { decimals: -1 }).value).toBe('12.5')
    expect(parseOcrNumber('12.5', { decimals: 1.5 }).value).toBe('12.5')
  })
})

describe('parseOcrNumber — confidence', () => {
  it('scales the engine confidence and stays within 0..1', () => {
    expect(parseOcrNumber('12.50', { decimals: 2 }, 0.93).confidence).toBe(0.93)
    expect(parseOcrNumber('12.50', { decimals: 2 }, 5).confidence).toBe(1)
    expect(parseOcrNumber('12.50', { decimals: 2 }, -1).confidence).toBe(0)
    expect(parseOcrNumber('12.50', { decimals: 2 }, Number.NaN).confidence).toBe(0)
  })

  it('ambiguity (several distinct readings) lowers confidence', () => {
    const one = parseOcrNumber('12.50', { decimals: 2 }, 1).confidence
    const two = parseOcrNumber('12.50 3', { decimals: 2 }, 1).confidence
    expect(two).toBeLessThan(one)
  })
})

describe('extractCandidates / scoreCandidate', () => {
  it('reports substitutions and inferred flags', () => {
    const c = extractCandidates('l2O', { decimals: 1 })
    expect(c[0]).toMatchObject({ value: '120', decimals: 0, substitutions: 2, inferred: false })
    expect(c[1]).toMatchObject({ value: '12.0', decimals: 1, inferred: true })
  })

  it('scores exact decimals over padded over excess', () => {
    const base = { substitutions: 0, inferred: false, digits: 3, index: 0 }
    const exact = scoreCandidate({ ...base, value: '1.25', decimals: 2 }, 2)
    const padded = scoreCandidate({ ...base, value: '12.5', decimals: 1 }, 2)
    const excess = scoreCandidate({ ...base, value: '0.125', decimals: 3 }, 2)
    expect(exact).toBeGreaterThan(padded)
    expect(padded).toBeGreaterThan(excess)
  })
})
