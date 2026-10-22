// Sync engine — ARCHITECTURE §6/§7. Order per cycle: upload pending blobs (HEAD, then PUT) → push the
// outbox in batches → pull until has_more=false → release checkouts whose run has nothing left to push.
// Invariant: a locally created event is only ever removed from the device after the server accepted it
// (it then stays in `events` with its seq) or explicitly rejected it (it then moves to `rejected`).

import { ref, type Ref } from 'vue'
import { ApiError, OfflineError } from '../api/client'
import { api as defaultApi, type Api } from '../api/endpoints'
import { blobRefsOf, type CheckoutRow, type StepTrackDB } from '../db'
import type { PullResponse, PushResult, RunCheckout, RunEvent, StepLock, Uuid } from '../domain/types'

export interface PullSummary {
  pages: number
  runIds: Set<Uuid>
  eventRunIds: Set<Uuid>
  procedures: number
  revisions: number
  tools: number
  workstations: number
  ncrs: number
  users: number
}

export interface PushSummary {
  accepted: RunEvent[]
  rejected: { event: RunEvent; error: string }[]
}

export interface SyncEngineOptions {
  db: StepTrackDB
  deviceId: () => Uuid
  /** null while nobody is signed in: no sync (the server would answer 401) */
  userId: () => Uuid | null
  api?: Api
  intervalMs?: number
  debounceMs?: number
  heartbeatMs?: number
  batchSize?: number
  pageLimit?: number
  onPulled?: (s: PullSummary) => void | Promise<void>
  onPushed?: (s: PushSummary) => void | Promise<void>
  /** local tables changed (locks, checkouts, rejected) without a pull */
  onLocalChange?: () => void | Promise<void>
  state?: SyncState
}

export type SyncErrorCode = 'auth' | 'server' | 'unknown'

/** Reactive engine state. Created separately so stores can bind to it before the engine exists. */
export interface SyncState {
  online: Ref<boolean>
  syncing: Ref<boolean>
  lastSyncAt: Ref<string | null>
  lastError: Ref<string | null>
  lastErrorCode: Ref<SyncErrorCode | null>
  pendingEvents: Ref<number>
  pendingBlobs: Ref<number>
  rejectedCount: Ref<number>
}

export function createSyncState(): SyncState {
  return {
    online: ref(typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    syncing: ref(false),
    lastSyncAt: ref<string | null>(null),
    lastError: ref<string | null>(null),
    lastErrorCode: ref<SyncErrorCode | null>(null),
    pendingEvents: ref(0),
    pendingBlobs: ref(0),
    rejectedCount: ref(0),
  }
}

/** releaseCheckout could not finish because events of the run are still waiting to be pushed. */
export class PendingSyncError extends Error {
  constructor(public readonly runId: string) {
    super('pending_sync')
    this.name = 'PendingSyncError'
  }
}

const MAX_PAGES_PER_SYNC = 10_000

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { detail?: unknown } | string | null
    if (b && typeof b === 'object' && 'detail' in b) return typeof b.detail === 'string' ? b.detail : JSON.stringify(b.detail)
    if (typeof b === 'string' && b) return b
    return e.message
  }
  return e instanceof Error ? e.message : String(e)
}

export class SyncEngine {
  readonly state: SyncState
  readonly online: Ref<boolean>
  readonly syncing: Ref<boolean>
  readonly lastSyncAt: Ref<string | null>
  readonly lastError: Ref<string | null>
  readonly lastErrorCode: Ref<SyncErrorCode | null>
  readonly pendingEvents: Ref<number>
  readonly pendingBlobs: Ref<number>
  readonly rejectedCount: Ref<number>

  private readonly db: StepTrackDB
  private readonly api: Api
  private readonly opts: Required<Pick<SyncEngineOptions, 'intervalMs' | 'debounceMs' | 'heartbeatMs' | 'batchSize' | 'pageLimit'>>
  private running: Promise<void> | null = null
  private rerun = false
  private timers: ReturnType<typeof setInterval>[] = []
  private debounce: ReturnType<typeof setTimeout> | null = null
  private cleanups: (() => void)[] = []
  private started = false
  private stopped = false

  constructor(private readonly o: SyncEngineOptions) {
    this.db = o.db
    this.api = o.api ?? defaultApi
    this.opts = {
      intervalMs: o.intervalMs ?? 30_000,
      debounceMs: o.debounceMs ?? 1_500,
      heartbeatMs: o.heartbeatMs ?? 30_000,
      batchSize: Math.min(o.batchSize ?? 500, 500),
      pageLimit: o.pageLimit ?? 500,
    }
    this.state = o.state ?? createSyncState()
    ;({
      online: this.online, syncing: this.syncing, lastSyncAt: this.lastSyncAt, lastError: this.lastError,
      lastErrorCode: this.lastErrorCode, pendingEvents: this.pendingEvents, pendingBlobs: this.pendingBlobs,
      rejectedCount: this.rejectedCount,
    } = this.state)
  }

  // ---------------------------------------------------------------------------
  // lifecycle & connectivity

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.refreshCounts()
    if (typeof window !== 'undefined') {
      const onOnline = () => void this.probe().then((ok) => { if (ok) void this.syncNow() })
      const onOffline = () => this.setOnline(false)
      window.addEventListener('online', onOnline)
      window.addEventListener('offline', onOffline)
      this.cleanups.push(() => {
        window.removeEventListener('online', onOnline)
        window.removeEventListener('offline', onOffline)
      })
    }
    void this.watchNativeNetwork()
    this.timers.push(setInterval(() => void this.syncNow(), this.opts.intervalMs))
    this.timers.push(setInterval(() => void this.heartbeat().catch(() => {}), this.opts.heartbeatMs))
    if (await this.probe()) void this.syncNow()
  }

  stop(): void {
    this.started = false
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    for (const c of this.cleanups) c()
    this.cleanups = []
  }

  private async watchNativeNetwork() {
    try {
      const { Capacitor } = await import('@capacitor/core')
      if (!Capacitor.isNativePlatform()) return
      const { Network } = await import('@capacitor/network')
      const status = await Network.getStatus()
      if (!status.connected) this.setOnline(false)
      const handle = await Network.addListener('networkStatusChange', (s) => {
        if (s.connected) void this.probe().then((ok) => { if (ok) void this.syncNow() })
        else this.setOnline(false)
      })
      if (!this.started) void handle.remove()
      else this.cleanups.push(() => void handle.remove())
    } catch {
      /* not native or plugin unavailable: browser events + probe suffice */
    }
  }

  private setOnline(v: boolean) {
    const was = this.online.value
    this.online.value = v
    if (v && !was) void this.syncNow()
  }

  /** GET /health. Any non-5xx answer means the server is reachable. */
  async probe(): Promise<boolean> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.online.value = false
      return false
    }
    let ok: boolean
    try {
      await this.api.health()
      ok = true
    } catch (e) {
      ok = e instanceof ApiError && e.status < 500
    }
    this.online.value = ok
    return ok
  }

  /** Debounced sync after local writes. */
  schedule(): void {
    void this.refreshCounts()
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.syncNow()
    }, this.opts.debounceMs)
  }

  async refreshCounts(): Promise<void> {
    try {
      const [e, b, r] = await Promise.all([
        this.db.outbox.count(),
        this.db.blobs.where('uploaded').equals(0).count(),
        this.db.rejected.where('acknowledged').equals(0).count(),
      ])
      this.pendingEvents.value = e
      this.pendingBlobs.value = b
      this.rejectedCount.value = r
    } catch {
      /* database closed during teardown; counters are cosmetic */
    }
  }

  /** Run one full cycle; concurrent callers share it, and a call during a cycle triggers one more. */
  syncNow(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false
          await this.cycle()
        } while (this.rerun)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  private async cycle(): Promise<void> {
    if (this.stopped || !this.o.userId()) return
    if (!this.online.value && !(await this.probe())) return
    this.syncing.value = true
    try {
      await this.uploadBlobs()
      await this.pushOutbox()
      await this.pull()
      await this.releaseRequestedCheckouts()
      this.lastSyncAt.value = new Date().toISOString()
      this.lastError.value = null
      this.lastErrorCode.value = null
    } catch (e) {
      if (e instanceof OfflineError) {
        this.online.value = false
      } else {
        this.lastError.value = errorText(e)
        this.lastErrorCode.value = e instanceof ApiError ? (e.status === 401 || e.status === 403 ? 'auth' : 'server') : 'unknown'
      }
    } finally {
      this.syncing.value = false
      await this.refreshCounts()
    }
  }

  // ---------------------------------------------------------------------------
  // blobs

  async uploadBlobs(): Promise<void> {
    const pending = await this.db.blobs.where('uploaded').equals(0).toArray()
    if (!pending.length) return
    // blobs referenced by queued events first: they gate run.completed on the server
    const outboxRows = await this.db.outbox.toArray()
    const queued = await this.db.events.bulkGet(outboxRows.map((r) => r.event_id))
    const referenced = new Set(queued.flatMap((e) => (e ? blobRefsOf(e) : [])))
    pending.sort((a, b) => Number(referenced.has(b.sha256)) - Number(referenced.has(a.sha256)))

    for (const row of pending) {
      try {
        if (!(await this.api.blobExists(row.sha256))) {
          await this.api.putBlob(row.sha256, new Blob([row.data], { type: row.mime }))
        }
        await this.db.blobs.update(row.sha256, { uploaded: 1, last_error: null })
      } catch (e) {
        if (e instanceof OfflineError || (e instanceof ApiError && (e.status === 401 || e.status >= 500))) throw e
        // a single bad blob must not hold back the event push; the server flags blob_missing meanwhile
        await this.db.blobs.update(row.sha256, { last_error: errorText(e) })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // push

  private async pushEvents(events: RunEvent[]): Promise<PushResult[]> {
    try {
      return (await this.api.push(this.o.deviceId(), events)).results ?? []
    } catch (e) {
      // A structural 4xx for the whole batch: bisect to find the offending event(s) instead of
      // blocking every later event behind one bad one.
      if (e instanceof ApiError && [400, 413, 422].includes(e.status)) {
        if (events.length > 1) {
          const mid = Math.ceil(events.length / 2)
          return [...(await this.pushEvents(events.slice(0, mid))), ...(await this.pushEvents(events.slice(mid)))]
        }
        if (e.status !== 413) return [{ id: events[0]!.id, status: 'rejected', error: errorText(e) }]
      }
      throw e
    }
  }

  async pushOutbox(): Promise<PushSummary> {
    const summary: PushSummary = { accepted: [], rejected: [] }
    const failedOids = new Set<number>()
    for (;;) {
      const rows = (await this.db.outbox.orderBy('oid').toArray()).filter((r) => !failedOids.has(r.oid!)).slice(0, this.opts.batchSize)
      if (!rows.length) break
      const events = await this.db.events.bulkGet(rows.map((r) => r.event_id))
      const sendable: RunEvent[] = []
      rows.forEach((r, i) => {
        const ev = events[i]
        if (ev) sendable.push(stripServerFields(ev))
        else failedOids.add(r.oid!) // should be impossible (atomic writes); keep the row for diagnosis
      })
      if (!sendable.length) continue

      const results = await this.pushEvents(sendable)
      const byId = new Map(results.map((r) => [r.id, r]))
      const now = new Date().toISOString()

      await this.db.transaction('rw', [this.db.events, this.db.outbox, this.db.rejected], async () => {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!
          const ev = events[i]
          if (!ev) continue
          const res = byId.get(ev.id)
          if (!res) {
            failedOids.add(row.oid!)
            await this.db.outbox.update(row.oid!, { attempts: row.attempts + 1, last_error: 'no_result' })
            continue
          }
          if (res.status === 'accepted' || res.status === 'duplicate') {
            const patch: Partial<RunEvent> = {}
            if (res.seq != null) patch.seq = res.seq
            if (res.flags) patch.flags = res.flags
            await this.db.events.update(ev.id, patch)
            await this.db.outbox.delete(row.oid!)
            summary.accepted.push({ ...ev, ...patch })
          } else {
            const error = res.error ?? 'rejected'
            await this.db.rejected.put({ event_id: ev.id, run_id: ev.run_id, event: ev, error, rejected_at: now, acknowledged: 0 })
            await this.db.events.delete(ev.id)
            await this.db.outbox.delete(row.oid!)
            summary.rejected.push({ event: ev, error })
          }
        }
      })
    }
    if (summary.accepted.length || summary.rejected.length) await this.o.onPushed?.(summary)
    return summary
  }

  // ---------------------------------------------------------------------------
  // pull

  private cursorKey(): string {
    return `cursor:${this.o.userId() ?? 'anon'}`
  }

  async pull(): Promise<PullSummary> {
    const summary: PullSummary = {
      pages: 0, runIds: new Set(), eventRunIds: new Set(), procedures: 0, revisions: 0, tools: 0, workstations: 0, ncrs: 0, users: 0,
    }
    let cursor = (await this.db.getMeta<string>(this.cursorKey())) ?? null
    for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const res = await this.api.pull(cursor, this.opts.pageLimit)
      await this.applyPull(res, summary)
      summary.pages++
      const stuck = res.cursor === cursor
      cursor = res.cursor
      if (!res.has_more || stuck) break
    }
    const changed = summary.pages > 0 && (summary.runIds.size || summary.eventRunIds.size || summary.procedures || summary.revisions ||
      summary.tools || summary.workstations || summary.ncrs || summary.users)
    if (changed) await this.o.onPulled?.(summary)
    return summary
  }

  private async applyPull(res: PullResponse, summary: PullSummary): Promise<void> {
    const db = this.db
    const incoming = res.events ?? []
    const now = new Date().toISOString()
    await db.transaction('rw', [db.procedures, db.revisions, db.runs, db.events, db.outbox, db.rejected, db.tools,
      db.workstations, db.ncrs, db.users, db.meta], async () => {
      if (res.procedures?.length) await db.procedures.bulkPut(res.procedures)
      if (res.revisions?.length) await db.revisions.bulkPut(res.revisions)
      if (res.runs?.length) await db.runs.bulkPut(res.runs)
      if (res.tools?.length) await db.tools.bulkPut(res.tools)
      if (res.workstations?.length) await db.workstations.bulkPut(res.workstations)
      if (res.ncrs?.length) await db.ncrs.bulkPut(res.ncrs)
      if (res.users?.length) await db.users.bulkPut(res.users)

      if (incoming.length) {
        const locals = await db.events.bulkGet(incoming.map((e) => e.id))
        for (let i = 0; i < incoming.length; i++) {
          const local = locals[i]
          const server = incoming[i]!
          if (local && local.content_hash !== server.content_hash) {
            // Same id, different content: the server's ledger is the record. Keep ours as rejected evidence.
            const queued = await db.outbox.where('event_id').equals(local.id).first()
            if (queued) await db.outbox.delete(queued.oid!)
            await db.rejected.put({ event_id: local.id, run_id: local.run_id, event: local, error: 'server_version_differs', rejected_at: now, acknowledged: 0 })
          }
          summary.eventRunIds.add(server.run_id)
        }
        await db.events.bulkPut(incoming)
      }
      await db.setMeta(this.cursorKey(), res.cursor)
    })
    for (const r of res.runs ?? []) summary.runIds.add(r.id)
    summary.procedures += res.procedures?.length ?? 0
    summary.revisions += res.revisions?.length ?? 0
    summary.tools += res.tools?.length ?? 0
    summary.workstations += res.workstations?.length ?? 0
    summary.ncrs += res.ncrs?.length ?? 0
    summary.users += res.users?.length ?? 0
  }

  // ---------------------------------------------------------------------------
  // locks & checkout (§6)

  async acquireLock(runId: Uuid, stepId: Uuid, force = false): Promise<StepLock> {
    const lock = await this.api.lockStep(runId, stepId, this.o.deviceId(), force)
    await this.db.transaction('rw', this.db.locks, async () => {
      // one lease per step: drop stale knowledge of other holders
      await this.db.locks.where('[run_id+step_id]').equals([runId, stepId]).delete()
      await this.db.locks.put({ ...lock, run_id: lock.run_id ?? runId, step_id: lock.step_id ?? stepId })
    })
    await this.o.onLocalChange?.()
    return lock
  }

  /** Remember a lease held by someone else (from a 409 body) so canEdit can explain it. */
  async rememberForeignLock(lock: StepLock): Promise<void> {
    await this.db.locks.put(lock)
    await this.o.onLocalChange?.()
  }

  async releaseLock(lockId: Uuid): Promise<void> {
    try {
      await this.api.releaseLock(lockId)
    } catch (e) {
      // already gone on the server is fine; anything else (offline) must surface
      if (!(e instanceof ApiError && (e.status === 404 || e.status === 410))) throw e
    }
    await this.db.locks.delete(lockId)
    await this.o.onLocalChange?.()
  }

  async heartbeat(): Promise<void> {
    if (!this.online.value || !this.o.userId()) return
    const mine = (await this.db.locks.toArray()).filter((l) => l.holder_device === this.o.deviceId())
    let changed = false
    for (const lock of mine) {
      try {
        const renewed = await this.api.heartbeat(lock.lock_id)
        await this.db.locks.put({ ...lock, ...renewed })
        changed = true
      } catch (e) {
        if (e instanceof OfflineError) {
          this.online.value = false
          break
        }
        if (e instanceof ApiError && [404, 409, 410].includes(e.status)) {
          await this.db.locks.delete(lock.lock_id)
          changed = true
        }
      }
    }
    // drop foreign leases we learned about once they have run out
    const now = new Date().toISOString()
    const expiredForeign = (await this.db.locks.toArray()).filter((l) => l.holder_device !== this.o.deviceId() && l.expires_at < now)
    if (expiredForeign.length) {
      await this.db.locks.bulkDelete(expiredForeign.map((l) => l.lock_id))
      changed = true
    }
    if (changed) await this.o.onLocalChange?.()
  }

  async acquireCheckout(runId: Uuid, hours?: number): Promise<RunCheckout> {
    const co = await this.api.checkout(runId, this.o.deviceId(), hours)
    await this.db.checkouts.put({ ...co, run_id: co.run_id ?? runId, implicit: false, release_requested: false })
    await this.o.onLocalChange?.()
    return co
  }

  /** Implicit checkout for a run created offline (§6): recorded locally, granted by the server on ingest. */
  implicitCheckoutRow(runId: Uuid, userId: Uuid, clientTs: string, hours = 12): CheckoutRow {
    return {
      run_id: runId,
      holder_user: userId,
      holder_device: this.o.deviceId(),
      expires_at: new Date(Date.parse(clientTs) + hours * 3600_000).toISOString(),
      implicit: true,
      release_requested: false,
    }
  }

  /**
   * Mark for release and sync. Resolves true once released; false when events of the run are still
   * waiting to be pushed (the release then happens automatically after a later successful push).
   */
  async requestCheckoutRelease(runId: Uuid): Promise<boolean> {
    const row = await this.db.checkouts.get(runId)
    if (!row) return true
    await this.db.checkouts.update(runId, { release_requested: true })
    await this.syncNow()
    return !(await this.db.checkouts.get(runId))
  }

  private async releaseRequestedCheckouts(): Promise<void> {
    const rows = (await this.db.checkouts.toArray()).filter((r) => r.release_requested)
    let changed = false
    for (const row of rows) {
      if ((await this.db.outbox.where('run_id').equals(row.run_id).count()) > 0) continue
      try {
        await this.api.releaseCheckout(row.run_id)
      } catch (e) {
        if (!(e instanceof ApiError && (e.status === 404 || e.status === 410))) throw e
      }
      await this.db.checkouts.delete(row.run_id)
      changed = true
    }
    if (changed) await this.o.onLocalChange?.()
  }
}

const SERVER_ONLY = ['seq', 'prev_chain_hash', 'chain_hash', 'server_ts', 'flags'] as const

/** The push body carries only client fields + content_hash; the server assigns the rest. */
export function stripServerFields(ev: RunEvent): RunEvent {
  const copy = { ...ev } as Record<string, unknown>
  for (const k of SERVER_ONLY) delete copy[k]
  return copy as unknown as RunEvent
}
