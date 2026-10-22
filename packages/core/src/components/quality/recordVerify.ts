// Local integrity check of a run ledger (ARCHITECTURE §5), independent of the server's /verify:
// recompute every content hash and, where the device has the server's chain data, the hash chain.
// Lets an auditor at an offline tablet see that the cached record has not been altered.
//
// Only definite contradictions are problems. An incomplete local copy is not: push results carry seq
// but no chain hashes (those arrive with the next pull), and events other devices pushed may not have
// been pulled yet, so seq gaps and missing chain fields are reported as information.
import { GENESIS_CHAIN_HASH, chainHash, eventContentHash, hashCanonical } from '../../domain/canonical'
import type { ProcedureRevision, RunEvent, Uuid } from '../../domain/types'

export type LedgerProblem =
  | { kind: 'content_hash'; event_id: Uuid }
  | { kind: 'unhashable'; event_id: Uuid }
  | { kind: 'chain_hash'; event_id: Uuid }
  | { kind: 'prev_link'; event_id: Uuid }
  | { kind: 'duplicate_seq'; event_id: Uuid }

export interface LedgerCheck {
  ok: boolean
  total: number
  /** events the server accepted (have seq) */
  accepted: number
  /** events not yet accepted by the server (outside the chain) */
  local: number
  /** accepted events whose chain link could be verified against their predecessor */
  linked: number
  /** accepted events without chain fields yet (pull pending) */
  unchained: number
  /** seq numbers below the highest known one that this device does not have */
  missing_seqs: number
  problems: LedgerProblem[]
}

export async function verifyLedger(events: readonly RunEvent[]): Promise<LedgerCheck> {
  const problems: LedgerProblem[] = []
  for (const e of events) {
    try {
      if ((await eventContentHash(e)) !== e.content_hash) problems.push({ kind: 'content_hash', event_id: e.id })
    } catch {
      // a float or other non-canonical value in the payload
      problems.push({ kind: 'unhashable', event_id: e.id })
    }
  }

  const accepted = events.filter((e) => e.seq != null).sort((a, b) => a.seq! - b.seq!)
  const bySeq = new Map<number, RunEvent>()
  for (const e of accepted) {
    if (bySeq.has(e.seq!)) problems.push({ kind: 'duplicate_seq', event_id: e.id })
    else bySeq.set(e.seq!, e)
  }

  let linked = 0
  let unchained = 0
  for (const e of bySeq.values()) {
    if (!e.chain_hash || !e.prev_chain_hash) {
      unchained++
      continue
    }
    if ((await chainHash(e.prev_chain_hash, e.content_hash)) !== e.chain_hash) problems.push({ kind: 'chain_hash', event_id: e.id })
    const expectedPrev = e.seq === 1 ? GENESIS_CHAIN_HASH : bySeq.get(e.seq! - 1)?.chain_hash
    if (expectedPrev) {
      if (expectedPrev !== e.prev_chain_hash) problems.push({ kind: 'prev_link', event_id: e.id })
      else linked++
    }
  }

  const maxSeq = accepted.length ? accepted[accepted.length - 1]!.seq! : 0
  return {
    ok: problems.length === 0,
    total: events.length,
    accepted: accepted.length,
    local: events.length - accepted.length,
    linked,
    unchained,
    missing_seqs: maxSeq - bySeq.size,
    problems,
  }
}

/** Does the revision's stored content still hash to its frozen content_hash? null = nothing to check (draft). */
export async function verifyRevisionHash(rev: Pick<ProcedureRevision, 'content' | 'content_hash'>): Promise<boolean | null> {
  if (!rev.content_hash) return null
  try {
    return (await hashCanonical(rev.content)) === rev.content_hash
  } catch {
    return false
  }
}
