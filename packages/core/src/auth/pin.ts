// Offline PIN verification — ARCHITECTURE §8.
// Verifier: "pbkdf2-sha256$<iterations>$<salt_b64>$<hash_b64>" (standard base64 with padding).

export const PIN_RE = /^[0-9]{6,12}$/

export function isValidPin(pin: string): boolean {
  return PIN_RE.test(pin)
}

export interface ParsedVerifier {
  iterations: number
  salt: Uint8Array
  hash: Uint8Array
}

function b64decode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null
  try {
    const bin = atob(s)
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

// Refuse absurd parameters from a tampered cache: too few iterations would make offline
// brute force trivial, too many would freeze the tablet.
const MIN_ITERATIONS = 100_000
const MAX_ITERATIONS = 5_000_000

export function parseVerifier(verifier: string): ParsedVerifier | null {
  const parts = verifier.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return null
  if (!/^[0-9]+$/.test(parts[1]!)) return null
  const iterations = Number(parts[1])
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return null
  const salt = b64decode(parts[2]!)
  const hash = b64decode(parts[3]!)
  if (!salt || !hash || salt.length < 16 || hash.length < 32) return null
  return { iterations, salt, hash }
}

/** Constant-time comparison so timing does not reveal how many leading bytes matched. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export async function verifyPin(pin: string, verifier: string | null | undefined): Promise<boolean> {
  if (!verifier || !isValidPin(pin)) return false
  const v = parseVerifier(verifier)
  if (!v) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: v.salt as BufferSource, iterations: v.iterations },
    key,
    v.hash.length * 8,
  )
  return constantTimeEqual(new Uint8Array(bits), v.hash)
}
