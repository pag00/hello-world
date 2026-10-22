// Canonical JSON + SHA-256 content hashing — ARCHITECTURE §5.
// Must byte-match Python: json.dumps(obj, sort_keys=True, separators=(",",":"), ensure_ascii=False)

import type { RunEvent, RunEventContent, Sha256Ref } from './types'

export class CanonicalJsonError extends Error {}

const SERVER_FIELDS = ['content_hash', 'seq', 'prev_chain_hash', 'chain_hash', 'server_ts', 'flags'] as const

export const GENESIS_CHAIN_HASH: Sha256Ref = 'sha256:' + '0'.repeat(64)

function escapeString(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x22) out += '\\"'
    else if (c === 0x5c) out += '\\\\'
    else if (c === 0x08) out += '\\b'
    else if (c === 0x0c) out += '\\f'
    else if (c === 0x0a) out += '\\n'
    else if (c === 0x0d) out += '\\r'
    else if (c === 0x09) out += '\\t'
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0')
    else out += s[i]
  }
  return out + '"'
}

// Python sorts str keys by code point; JS default sort compares UTF-16 code units,
// which differs for astral-plane characters. Compare by code point explicitly.
function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]()
  const ib = b[Symbol.iterator]()
  for (;;) {
    const x = ia.next()
    const y = ib.next()
    if (x.done) return y.done ? 0 : -1
    if (y.done) return 1
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!
    if (d !== 0) return d
  }
}

export function canonicalJson(value: unknown, path = '$'): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isInteger(value)) throw new CanonicalJsonError(`float not allowed at ${path}: ${value}`)
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`integer out of range at ${path}`)
      return String(value)
    case 'string':
      return escapeString(value)
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map((v, i) => canonicalJson(v, `${path}[${i}]`)).join(',') + ']'
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(compareCodePoints)
      return '{' + keys.map((k) => escapeString(k) + ':' + canonicalJson(obj[k], `${path}.${k}`)).join(',') + '}'
    }
    default:
      throw new CanonicalJsonError(`unsupported type ${typeof value} at ${path}`)
  }
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hashCanonical(value: unknown): Promise<Sha256Ref> {
  return 'sha256:' + (await sha256Hex(canonicalJson(value)))
}

/** Strip server-assigned fields and content_hash, then hash. */
export async function eventContentHash(event: RunEventContent | RunEvent): Promise<Sha256Ref> {
  const copy: Record<string, unknown> = { ...event }
  for (const f of SERVER_FIELDS) delete copy[f]
  return hashCanonical(copy)
}

export async function chainHash(prev: Sha256Ref, contentHash: Sha256Ref): Promise<Sha256Ref> {
  return 'sha256:' + (await sha256Hex(prev + contentHash))
}

export async function sealEvent<T extends RunEventContent>(content: T): Promise<T & { content_hash: Sha256Ref }> {
  return { ...content, content_hash: await eventContentHash(content) }
}
