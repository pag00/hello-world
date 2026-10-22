import { describe, expect, it } from 'vitest'
import vectors from '../../../../spec/test-vectors/canonical.json'
import { CanonicalJsonError, GENESIS_CHAIN_HASH, canonicalJson, chainHash, eventContentHash, hashCanonical } from './canonical'
import type { RunEventContent } from './types'

describe('canonical JSON (shared vectors)', () => {
  for (const c of vectors.cases) {
    it(c.name, async () => {
      expect(canonicalJson(c.value)).toBe(c.canonical)
      expect(await hashCanonical(c.value)).toBe(c.hash)
    })
  }

  for (const r of vectors.rejects) {
    it(`rejects ${r.name}`, () => {
      expect(() => canonicalJson(r.value)).toThrow(CanonicalJsonError)
    })
  }

  it('chain', async () => {
    expect(vectors.chain.genesis).toBe(GENESIS_CHAIN_HASH)
    let prev = GENESIS_CHAIN_HASH
    for (const [i, e] of vectors.chain.events.entries()) {
      const ch = await eventContentHash(e as RunEventContent)
      expect(ch).toBe(vectors.chain.content_hashes[i])
      prev = await chainHash(prev, ch)
      expect(prev).toBe(vectors.chain.chain_hashes[i])
    }
  })

  it('ignores server fields and content_hash', async () => {
    const e = vectors.chain.events[0] as RunEventContent
    const withServer = { ...e, content_hash: 'sha256:x', seq: 3, flags: ['conflict'], server_ts: 'x', chain_hash: 'y', prev_chain_hash: 'z' }
    expect(await eventContentHash(withServer as never)).toBe(vectors.chain.content_hashes[0])
  })
})
