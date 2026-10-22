import { describe, expect, it } from 'vitest'
import { isUuid, uuidv7, uuidv7Timestamp } from '../../src/domain/uuid'

describe('uuidv7', () => {
  it('has version 7 and RFC variant', () => {
    for (let i = 0; i < 200; i++) {
      const id = uuidv7()
      expect(isUuid(id)).toBe(true)
      expect(id[14]).toBe('7')
      expect('89ab').toContain(id[19]!)
    }
  })

  it('is strictly increasing within one millisecond and across many ids', () => {
    const fixed = Date.now() + 10_000_000
    const ids = Array.from({ length: 5000 }, () => uuidv7(fixed))
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
    const mixed = Array.from({ length: 20000 }, () => uuidv7())
    expect([...mixed].sort()).toEqual(mixed)
  })

  it('stays monotonic when the clock steps backwards', () => {
    const t = Date.now() + 20_000_000
    const a = uuidv7(t)
    const b = uuidv7(t - 5000)
    expect(b > a).toBe(true)
  })

  it('encodes the timestamp', () => {
    // later than any timestamp used elsewhere in this file, so the monotonic guard does not kick in
    const t = Date.UTC(2099, 9, 22, 10, 31, 5, 123)
    expect(uuidv7Timestamp(uuidv7(t))).toBe(t)
  })
})
