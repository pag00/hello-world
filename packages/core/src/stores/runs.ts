import { defineStore } from 'pinia'
import { computed, ref, shallowReactive, watch, type ComputedRef } from 'vue'
import type { EditCheck, RunsStore, Signer } from './contracts'
import type {
  EventPayloads, EventType, Ncr, Run, RunCheckout, RunEvent, RunEventContent, RunProjection, StepLock, Uuid,
} from '../domain/types'
import { sealEvent } from '../domain/canonical'
import { toFixedDecimals } from '../domain/decimal'
import { findInput, findStep, orderEvents, projectRun, projectRunDetailed } from '../domain/projection'
import { uuidv7 } from '../domain/uuid'
import { V, ValidationError, validateEvent, validateRunCreation } from '../domain/validation'
import { ApiError, OfflineError } from '../api/client'
import type { CheckoutRow, LockRow } from '../db'
import { PendingSyncError, type PushSummary } from '../sync/engine'
import { getDb, getEngine, syncState } from '../sync/runtime'
import { useProceduresStore } from './procedures'
import { useRegistryStore } from './registry'
import { useSessionStore } from './session'

export interface RunsStoreImpl extends RunsStore {
  hydrate(): Promise<void>
  /** make sure a run's ledger is in memory (events() loads lazily and returns [] until then) */
  loadEvents(runId: Uuid): Promise<RunEvent[]>
  applyPulled(eventRunIds: Set<Uuid>): Promise<void>
  applyPushed(s: PushSummary): Promise<void>
  reloadLocal(): Promise<void>
  getRun(runId: Uuid): Run | null
}

const CLOSED = new Set(['completed', 'aborted'])

function byCreatedDesc(a: Run, b: Run) {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
}

/** Body of a 409 lock refusal, if the server told us who holds the lease. */
function lockFromConflict(e: unknown): StepLock | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null
  const b = e.body as Record<string, unknown> | null
  const candidates = [b, b?.lock, b?.detail, (b?.detail as Record<string, unknown> | undefined)?.lock]
  for (const c of candidates) {
    if (c && typeof c === 'object' && 'lock_id' in c && 'holder_device' in c && 'expires_at' in c) return c as unknown as StepLock
  }
  return null
}

export const useRunsStore = defineStore('st-runs', (): RunsStoreImpl => {
  const runs = ref<Run[]>([])
  const activeRunId = ref<Uuid | null>(null)
  const eventsByRun = shallowReactive(new Map<Uuid, RunEvent[]>())
  const loading = new Map<Uuid, Promise<RunEvent[]>>()
  const lockRows = ref<LockRow[]>([])
  const checkoutRows = ref<CheckoutRow[]>([])
  const projections = new Map<Uuid, ComputedRef<RunProjection | null>>()
  let hydrated = false

  const procedures = useProceduresStore()
  const registry = useRegistryStore()
  const session = useSessionStore()

  watch(activeRunId, (id) => {
    if (hydrated) void getDb().setMeta('active_run_id', id)
  })

  function getRun(runId: Uuid): Run | null {
    return runs.value.find((r) => r.id === runId) ?? null
  }

  function setEvents(runId: Uuid, evs: RunEvent[]) {
    eventsByRun.set(runId, orderEvents(evs))
  }

  function loadEvents(runId: Uuid): Promise<RunEvent[]> {
    let p = loading.get(runId)
    if (!p) {
      p = getDb().events.where('run_id').equals(runId).toArray().then((evs) => {
        setEvents(runId, evs)
        return eventsByRun.get(runId)!
      }).finally(() => loading.delete(runId))
      loading.set(runId, p)
    }
    return p
  }

  async function ensureEvents(runId: Uuid): Promise<RunEvent[]> {
    return eventsByRun.get(runId) ?? loadEvents(runId)
  }

  async function reloadLocal() {
    const db = getDb()
    const [l, c] = await Promise.all([db.locks.toArray(), db.checkouts.toArray()])
    lockRows.value = l
    checkoutRows.value = c
  }

  async function hydrate() {
    const db = getDb()
    runs.value = (await db.runs.toArray()).sort(byCreatedDesc)
    await reloadLocal()
    activeRunId.value = (await db.getMeta<Uuid | null>('active_run_id')) ?? null
    hydrated = true
    // ledgers of open or checked-out runs are needed right away; closed ones load on demand
    const eager = new Set(runs.value.filter((r) => !CLOSED.has(r.status)).map((r) => r.id))
    for (const c of checkoutRows.value) eager.add(c.run_id)
    await Promise.all([...eager].map(loadEvents))
  }

  async function applyPulled(eventRunIds: Set<Uuid>) {
    runs.value = (await getDb().runs.toArray()).sort(byCreatedDesc)
    await Promise.all([...eventRunIds].filter((id) => eventsByRun.has(id)).map(loadEvents))
  }

  async function applyPushed(s: PushSummary) {
    const touched = new Set([...s.accepted, ...s.rejected.map((r) => r.event)].map((e) => e.run_id))
    await Promise.all([...touched].filter((id) => eventsByRun.has(id)).map(loadEvents))
    if (s.rejected.length) {
      // a rejected event no longer counts for the local projection: recompute cached run status
      for (const runId of touched) await refreshRunStatus(runId)
    }
  }

  function revisionContentOf(run: Run) {
    return procedures.getRevision(run.revision_id)?.content ?? null
  }

  async function refreshRunStatus(runId: Uuid) {
    const run = getRun(runId)
    const content = run && revisionContentOf(run)
    if (!run || !content) return
    const p = projectRun(runId, content, eventsByRun.get(runId) ?? [])
    if (p.status !== run.status) {
      const updated = { ...run, status: p.status }
      await getDb().runs.put(updated)
      runs.value = runs.value.map((r) => (r.id === runId ? updated : r))
    }
  }

  function events(runId: Uuid): RunEvent[] {
    const evs = eventsByRun.get(runId)
    if (!evs) {
      void loadEvents(runId)
      return []
    }
    return evs
  }

  function projection(runId: Uuid): ComputedRef<RunProjection | null> {
    let c = projections.get(runId)
    if (!c) {
      c = computed(() => {
        const run = getRun(runId)
        const content = run && revisionContentOf(run)
        if (!run || !content) return null
        return projectRun(runId, content, events(runId))
      })
      projections.set(runId, c)
    }
    return c
  }

  /** Local NCR row mirroring ncr.* events so NCRs raised offline show up before the server knows them. */
  function ncrPatch(ev: RunEvent, existing: Ncr | undefined, stepOfNcr: Uuid | null): Ncr | null {
    const p = ev.payload as Record<string, unknown>
    if (ev.type === 'ncr.raised') {
      return {
        id: p.ncr_id as Uuid, run_id: ev.run_id, step_id: ev.step_id, input_id: (p.input_id as Uuid | undefined) ?? null,
        number: (p.number as string | undefined) ?? null, description: p.description as string, status: 'open',
        disposition: null, disposition_note: null, raised_by: ev.actor_id, raised_at: ev.client_ts,
        dispositioned_by: null, dispositioned_at: null, closed_by: null, closed_at: null,
      }
    }
    if (!existing) return null
    if (ev.type === 'ncr.dispositioned') {
      return { ...existing, step_id: existing.step_id ?? stepOfNcr, status: 'dispositioned', disposition: p.disposition as Ncr['disposition'],
        disposition_note: p.note as string, dispositioned_by: ev.actor_id, dispositioned_at: ev.client_ts }
    }
    if (ev.type === 'ncr.closed') return { ...existing, status: 'closed', closed_by: ev.actor_id, closed_at: ev.client_ts }
    return null
  }

  // One write at a time per run: validation must see every earlier event (a double tap on "complete"
  // must not produce two completions), and the in-memory ledger must not be overwritten by a stale copy.
  const writeQueues = new Map<Uuid, Promise<unknown>>()
  function serialized<R>(runId: Uuid, fn: () => Promise<R>): Promise<R> {
    const p = (writeQueues.get(runId) ?? Promise.resolve()).then(fn, fn)
    writeQueues.set(runId, p.catch(() => {}))
    return p
  }

  function append<T extends EventType>(
    runId: Uuid, type: T, stepId: Uuid | null, payload: EventPayloads[T], signer?: Signer, supersedes: Uuid | null = null,
  ): Promise<RunEvent<T>> {
    return serialized(runId, () => appendNow(runId, type, stepId, payload, signer, supersedes))
  }

  async function appendNow<T extends EventType>(
    runId: Uuid, type: T, stepId: Uuid | null, payload: EventPayloads[T], signer?: Signer, supersedes: Uuid | null = null,
  ): Promise<RunEvent<T>> {
    await session.ready()
    const s = signer ?? session.defaultSigner()
    const run = getRun(runId)
    if (!run) throw new ValidationError([V + 'unknownRun'])
    const content = revisionContentOf(run)
    if (!content) throw new ValidationError([V + 'unknownRevision'])
    const existing = await ensureEvents(runId)

    const ev: RunEventContent<T> = {
      id: uuidv7(),
      run_id: runId,
      type,
      step_id: stepId,
      payload,
      actor_id: s.user.id,
      auth_method: s.auth_method,
      device_id: session.deviceId,
      client_ts: new Date().toISOString(),
      offline: !syncState.online.value,
      supersedes,
    }
    const detail = projectRunDetailed(runId, content, existing)
    const problems = validateEvent(
      { content, events: existing, actor: s.user, online: syncState.online.value, checkTool: (c) => registry.checkTool(c), detail },
      ev,
    )
    if (problems.length) throw new ValidationError(problems)

    // hash outside the transaction: IndexedDB transactions auto-commit across non-IDB awaits
    const sealed = (await sealEvent(ev)) as RunEvent<T>
    const next = [...existing, sealed as RunEvent]
    const nextStatus = projectRun(runId, content, next).status
    const runPatch: Run = nextStatus === run.status ? run : {
      ...run, status: nextStatus, closed_at: CLOSED.has(nextStatus) ? sealed.client_ts : run.closed_at,
    }

    const db = getDb()
    let ncrRow: Ncr | null = null
    if (type.startsWith('ncr.')) {
      const ncrId = (payload as { ncr_id: Uuid }).ncr_id
      ncrRow = ncrPatch(sealed, await db.ncrs.get(ncrId), detail.ncrs.get(ncrId)?.step_id ?? null)
    }
    await db.transaction('rw', [db.events, db.outbox, db.runs, db.ncrs], async () => {
      await db.events.add(sealed)
      await db.outbox.add({ event_id: sealed.id, run_id: runId, queued_at: sealed.client_ts, attempts: 0, last_error: null })
      if (runPatch !== run) await db.runs.put(runPatch)
      if (ncrRow) await db.ncrs.put(ncrRow)
    })

    setEvents(runId, [...(eventsByRun.get(runId) ?? existing).filter((e) => e.id !== sealed.id), sealed])
    if (runPatch !== run) runs.value = runs.value.map((r) => (r.id === runId ? runPatch : r))
    if (ncrRow) void registry.reloadNcrs()
    getEngine().schedule()
    return sealed
  }

  async function startRun(input: { revisionId: Uuid; serial: string; workOrder?: string | null }): Promise<Run> {
    await session.ready()
    const signer = session.defaultSigner()
    const rev = procedures.getRevision(input.revisionId)
    const serial = input.serial.trim()
    const problems = validateRunCreation({ actor: signer.user, revisionStatus: rev?.status ?? null, serial })
    if (problems.length || !rev) throw new ValidationError(problems)

    const runId = uuidv7()
    const offline = !syncState.online.value
    const content: RunEventContent<'run.created'> = {
      id: uuidv7(),
      run_id: runId,
      type: 'run.created',
      step_id: null,
      payload: { procedure_id: rev.procedure_id, revision_id: rev.id, serial, work_order: input.workOrder?.trim() || null },
      actor_id: signer.user.id,
      auth_method: signer.auth_method,
      device_id: session.deviceId,
      client_ts: new Date().toISOString(),
      offline,
      supersedes: null,
    }
    const sealed = await sealEvent(content)
    const run: Run = {
      id: runId, procedure_id: rev.procedure_id, revision_id: rev.id, serial, work_order: content.payload.work_order,
      status: 'active', created_by: signer.user.id, created_at: content.client_ts, closed_at: null,
    }
    const checkout = offline ? getEngine().implicitCheckoutRow(runId, signer.user.id, content.client_ts) : null

    const db = getDb()
    await db.transaction('rw', [db.events, db.outbox, db.runs, db.checkouts], async () => {
      await db.runs.add(run)
      await db.events.add(sealed)
      await db.outbox.add({ event_id: sealed.id, run_id: runId, queued_at: content.client_ts, attempts: 0, last_error: null })
      if (checkout) await db.checkouts.put(checkout)
    })
    runs.value = [run, ...runs.value]
    setEvents(runId, [sealed])
    if (checkout) checkoutRows.value = [...checkoutRows.value.filter((c) => c.run_id !== runId), checkout]
    activeRunId.value = runId
    getEngine().schedule()
    return run
  }

  function contentFor(runId: Uuid) {
    const run = getRun(runId)
    return run ? revisionContentOf(run) : null
  }

  function validateComplete(runId: Uuid, stepId: Uuid): string[] {
    if (!session.user) return [V + 'noUser']
    const content = contentFor(runId)
    if (!content) return [V + 'unknownRun']
    const ev: RunEventContent<'step.completed'> = {
      id: '', run_id: runId, type: 'step.completed', step_id: stepId, payload: {}, actor_id: session.user.id,
      auth_method: 'oidc', device_id: session.deviceId, client_ts: '', offline: !syncState.online.value, supersedes: null,
    }
    return validateEvent({ content, events: events(runId), actor: session.user, online: syncState.online.value, checkTool: (c) => registry.checkTool(c) }, ev)
  }

  function canEdit(runId: Uuid, stepId: Uuid): EditCheck {
    const p = projection(runId).value
    const run = getRun(runId)
    if ((p && CLOSED.has(p.status)) || (run && CLOSED.has(run.status))) return { ok: false, reason: 'run_closed' }
    const me = session.deviceId
    const now = new Date().toISOString()
    const co = checkoutRows.value.find((c) => c.run_id === runId && c.expires_at > now)
    if (co && co.holder_device !== me) return { ok: false, reason: 'checked_out_by_other' }
    if (co) return { ok: true }
    if (!syncState.online.value) return { ok: false, reason: 'offline_not_checked_out' }
    const live = lockRows.value.filter((l) => l.run_id === runId && l.step_id === stepId && l.expires_at > now)
    if (live.some((l) => l.holder_device === me)) return { ok: true }
    if (live.length) return { ok: false, reason: 'locked_by_other' }
    return { ok: false, reason: 'not_locked' }
  }

  function requireOnline() {
    if (!syncState.online.value) throw new OfflineError()
  }

  async function lockStep(runId: Uuid, stepId: Uuid, opts?: { force?: boolean }): Promise<StepLock> {
    requireOnline()
    const previous = lockRows.value.find((l) => l.run_id === runId && l.step_id === stepId && l.holder_device !== session.deviceId)
    let lock: StepLock
    try {
      lock = await getEngine().acquireLock(runId, stepId, !!opts?.force)
    } catch (e) {
      const foreign = lockFromConflict(e)
      if (foreign) await getEngine().rememberForeignLock({ ...foreign, run_id: foreign.run_id ?? runId, step_id: foreign.step_id ?? stepId })
      throw e
    }
    if (opts?.force) {
      // §6: a take-over is part of the record
      const from = previous ? ` from user ${previous.holder_user} (device ${previous.holder_device})` : ''
      await append(runId, 'note.added', stepId, { text: `Step lock taken over${from}`, system: 'lock_takeover' })
    }
    return lock
  }

  async function releaseStep(runId: Uuid, stepId: Uuid): Promise<void> {
    const mine = lockRows.value.filter((l) => l.run_id === runId && l.step_id === stepId && l.holder_device === session.deviceId)
    for (const l of mine) await getEngine().releaseLock(l.lock_id)
  }

  async function releaseCheckout(runId: Uuid): Promise<void> {
    requireOnline()
    const released = await getEngine().requestCheckoutRelease(runId)
    await reloadLocal()
    if (!released) throw new PendingSyncError(runId)
  }

  function ncrStep(runId: Uuid, ncrId: Uuid): Uuid | null {
    const content = contentFor(runId)
    if (!content) return null
    return projectRunDetailed(runId, content, events(runId)).ncrs.get(ncrId)?.step_id
      ?? registry.ncrs.find((n) => n.id === ncrId)?.step_id ?? null
  }

  return {
    runs,
    activeRunId,
    hydrate,
    loadEvents,
    applyPulled,
    applyPushed,
    reloadLocal,
    getRun,
    events,
    projection,
    startRun,

    async recordInput(args) {
      const content = contentFor(args.runId)
      const step = content && findStep(content, args.stepId)
      const input = step && findInput(step, args.inputId)
      let value = args.value
      if (input?.type === 'number' && typeof value === 'string') {
        const r = toFixedDecimals(value, input.decimals)
        if (!r.ok) throw new ValidationError([V + (r.error === 'too_many_decimals' ? 'tooManyDecimals' : 'invalidNumber')])
        value = r.value
      } else if (input?.type === 'scan' && typeof value === 'string') {
        value = value.trim()
      }
      const payload: EventPayloads['input.recorded'] = { input_id: args.inputId, value, source: args.source }
      if (args.ocrRaw !== undefined) payload.ocr_raw = args.ocrRaw
      return append(args.runId, 'input.recorded', args.stepId, payload, args.signer, args.supersedes ?? null)
    },
    startStep: (runId, stepId, signer) => append(runId, 'step.started', stepId, {}, signer),
    completeStep: (runId, stepId, signer) => append(runId, 'step.completed', stepId, {}, signer),
    verifyStep: (runId, stepId, signer) => append(runId, 'step.verified', stepId, {}, signer),
    reopenStep: (runId, stepId, reason, signer) => append(runId, 'step.reopened', stepId, { reason: reason.trim() }, signer),
    addNote: (runId, stepId, text, signer) => append(runId, 'note.added', stepId, { text: text.trim() }, signer),
    raiseNcr: ({ runId, stepId, inputId, description, signer }) => {
      const payload: EventPayloads['ncr.raised'] = { ncr_id: uuidv7(), description: description.trim() }
      if (inputId) payload.input_id = inputId
      return append(runId, 'ncr.raised', stepId, payload, signer)
    },
    dispositionNcr: ({ runId, ncrId, disposition, note, signer }) =>
      append(runId, 'ncr.dispositioned', ncrStep(runId, ncrId), { ncr_id: ncrId, disposition, note: note.trim() }, signer),
    closeNcr: (runId, ncrId, signer) => append(runId, 'ncr.closed', ncrStep(runId, ncrId), { ncr_id: ncrId }, signer),
    resolveConflict: ({ runId, stepId, keep, reject, reason }) =>
      append(runId, 'conflict.resolved', stepId, { kept_event_ids: keep, rejected_event_ids: reject, reason: reason.trim() }),
    completeRun: (runId) => append(runId, 'run.completed', null, {}),
    abortRun: (runId, reason) => append(runId, 'run.aborted', null, { reason: reason.trim() }),
    validateComplete,

    canEdit,
    lockStep,
    releaseStep,
    locks: (runId) => lockRows.value.filter((l) => l.run_id === runId),
    async checkout(runId, hours) {
      requireOnline()
      const co = await getEngine().acquireCheckout(runId, hours)
      await reloadLocal()
      return co
    },
    releaseCheckout,
    checkoutOf: (runId): RunCheckout | null => checkoutRows.value.find((c) => c.run_id === runId) ?? null,
  }
})
