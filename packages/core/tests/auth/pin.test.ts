import { pbkdf2Sync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { constantTimeEqual, isValidPin, parseVerifier, verifyPin } from '../../src/auth/pin'

function makeVerifier(pin: string, iterations = 210000, salt = randomBytes(16)) {
  const hash = pbkdf2Sync(Buffer.from(pin, 'utf8'), salt, iterations, 32, 'sha256')
  return `pbkdf2-sha256$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`
}

describe('PIN verify (§8)', () => {
  const verifier = makeVerifier('482913')

  it('accepts the right PIN against a node:crypto verifier', async () => {
    expect(await verifyPin('482913', verifier)).toBe(true)
  })

  it('rejects wrong PINs and malformed input', async () => {
    expect(await verifyPin('482914', verifier)).toBe(false)
    expect(await verifyPin('48291', verifier)).toBe(false) // too short, never hashed
    expect(await verifyPin('48291a', verifier)).toBe(false)
    expect(await verifyPin('482913', null)).toBe(false)
    expect(await verifyPin('482913', 'garbage')).toBe(false)
  })

  it('handles 12-digit PINs', async () => {
    expect(await verifyPin('123456789012', makeVerifier('123456789012'))).toBe(true)
  })

  it('validates verifier format and refuses weak parameters', () => {
    expect(parseVerifier(verifier)?.iterations).toBe(210000)
    expect(parseVerifier(verifier.replace('pbkdf2-sha256', 'pbkdf2-sha1'))).toBeNull()
    expect(parseVerifier(makeVerifier('123456', 1000))).toBeNull()
    expect(parseVerifier('pbkdf2-sha256$210000$!!!$AAAA')).toBeNull()
    expect(parseVerifier('pbkdf2-sha256$210000$' + Buffer.alloc(4).toString('base64') + '$' + Buffer.alloc(32).toString('base64'))).toBeNull()
  })

  it('pin format and constant-time compare', () => {
    expect(isValidPin('123456')).toBe(true)
    expect(isValidPin('1234567890123')).toBe(false)
    expect(isValidPin('١٢٣٤٥٦')).toBe(false) // non-ASCII digits
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false)
  })
})
