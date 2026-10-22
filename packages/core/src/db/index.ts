// Offline database (IndexedDB via Dexie 4). The events table is the device's copy of every run ledger;
// the outbox only references event ids, and both are written in one transaction so an event can never
// exist without being queued for upload (or vice versa).
import Dexie, { type EntityTable } from 'dexie'
import type {
  Ncr, Procedure, ProcedureRevision, Run, RunCheckout, RunEvent, StepLock, Tool, User, Uuid, Workstation,
} from '../domain/types'

export interface OutboxRow {
  /** auto-increment: push order = creation order (supersedes / run.created must precede dependants) */
  oid?: number
  event_id: Uuid
  run_id: Uuid
  queued_at: string
  attempts: number
  last_error: string | null
}

export interface BlobRow {
  /** hex, without "sha256:" */
  sha256: string
  /** raw bytes; ArrayBuffer rather than Blob because some WebViews fail to persist Blobs in IndexedDB */
  data: ArrayBuffer
  mime: string
  size: number
  /** 0 = waiting for upload, 1 = on the server (IndexedDB cannot index booleans) */
  uploaded: 0 | 1
  created_at: string
  last_error?: string | null
}

export interface MetaRow {
  key: string
  value: unknown
}

export interface CheckoutRow extends RunCheckout {
  /** implicit checkout recorded locally for a run created offline (§6), not yet confirmed by the server */
  implicit?: boolean
  /** user asked to release; done by the sync engine once the run's outbox is empty (§7) */
  release_requested?: boolean
}

export interface LockRow extends StepLock {}

export interface RejectedRow {
  event_id: Uuid
  run_id: Uuid
  /** the full event as created — rejected evidence is never discarded */
  event: RunEvent
  error: string
  rejected_at: string
  /** 0 = needs attention, 1 = a user acknowledged it (still kept) */
  acknowledged: 0 | 1
}

export class StepTrackDB extends Dexie {
  procedures!: EntityTable<Procedure, 'id'>
  revisions!: EntityTable<ProcedureRevision, 'id'>
  runs!: EntityTable<Run, 'id'>
  events!: EntityTable<RunEvent, 'id'>
  outbox!: EntityTable<OutboxRow, 'oid'>
  blobs!: EntityTable<BlobRow, 'sha256'>
  meta!: EntityTable<MetaRow, 'key'>
  users!: EntityTable<User, 'id'>
  tools!: EntityTable<Tool, 'id'>
  workstations!: EntityTable<Workstation, 'code'>
  ncrs!: EntityTable<Ncr, 'id'>
  locks!: EntityTable<LockRow, 'lock_id'>
  checkouts!: EntityTable<CheckoutRow, 'run_id'>
  rejected!: EntityTable<RejectedRow, 'event_id'>

  constructor(name = 'steptrack') {
    super(name)
    this.version(1).stores({
      procedures: 'id, number',
      revisions: 'id, procedure_id, status',
      runs: 'id, procedure_id, revision_id, status',
      events: 'id, run_id, [run_id+seq]',
      outbox: '++oid, &event_id, run_id',
      blobs: 'sha256, uploaded',
      meta: 'key',
      users: 'id',
      tools: 'id, code',
      workstations: 'code',
      ncrs: 'id, run_id',
      locks: 'lock_id, run_id, [run_id+step_id]',
      checkouts: 'run_id',
      rejected: 'event_id, run_id, acknowledged',
    })
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.meta.get(key))?.value as T | undefined
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.meta.put({ key, value })
  }
}

const SHA_RE = /sha256:([0-9a-f]{64})/g

/** Blob hashes referenced anywhere in an event payload (photo values, media, …). */
export function blobRefsOf(event: Pick<RunEvent, 'payload'>): string[] {
  const out = new Set<string>()
  const walk = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(SHA_RE)) out.add(m[1]!)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(event.payload)
  return [...out]
}
