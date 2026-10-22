// UUIDv7 (RFC 9562). Ids are created on whichever device creates the object, so they must sort by
// creation time even for several ids within one millisecond (outbox order, event tie-breaks).
// rand_a (12 bits) is used as a counter that is re-seeded every new millisecond (RFC 9562 §6.2, method 1).

let lastMs = -1
let counter = 0

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

export function uuidv7(now: number = Date.now()): string {
  let ms = now
  if (ms <= lastMs) {
    // same millisecond or clock stepped backwards: stay on lastMs and count up
    ms = lastMs
    counter++
    if (counter > 0xfff) {
      ms = ++lastMs
      counter = randomBytes(2)[0]! & 0x7f
    }
  } else {
    lastMs = ms
    // leave headroom so a burst within one ms does not overflow immediately
    const r = randomBytes(2)
    counter = ((r[0]! << 8) | r[1]!) & 0x7ff
  }

  const bytes = randomBytes(16)
  // 48-bit big-endian timestamp; Math.floor division keeps it exact beyond 2^32
  const hi = Math.floor(ms / 0x10000)
  const lo = ms % 0x10000
  bytes[0] = (hi >>> 24) & 0xff
  bytes[1] = (hi >>> 16) & 0xff
  bytes[2] = (hi >>> 8) & 0xff
  bytes[3] = hi & 0xff
  bytes[4] = (lo >>> 8) & 0xff
  bytes[5] = lo & 0xff
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f)
  bytes[7] = counter & 0xff
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s)
}

/** Milliseconds since epoch encoded in a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  const hex = id.replace(/-/g, '').slice(0, 12)
  return parseInt(hex, 16)
}
