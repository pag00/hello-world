// Run projection — ARCHITECTURE §4 "Projection rules". The server implements the same rules; both must
// pass spec/test-vectors/projection/*.json. Pure and synchronous: called inside Vue computeds.

import { isOutOfTolerance } from './limits'
import type {
  BlockReason, Input, InputProjection, InputValue, NcrStatus, RevisionContent, RunEvent, RunProjection,
  RunStatus, Step, StepProjection, StepState, Uuid,
} from './types'

/** Rule 1: accepted events by seq, then local ones by client_ts, then id. */
export function compareEvents(a: RunEvent, b: RunEvent): number {
  const sa = a.seq ?? null
  const sb = b.seq ?? null
  if (sa !== null && sb !== null) return sa - sb
  if (sa !== null) return -1
  if (sb !== null) return 1
  if (a.client_ts !== b.client_ts) return a.client_ts < b.client_ts ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function orderEvents(events: readonly RunEvent[]): RunEvent[] {
  return [...events].sort(compareEvents)
}

/** Rule 2: superseded by any event, or rejected by any conflict.resolved. */
export function deadEventIds(events: readonly RunEvent[]): Set<Uuid> {
  const dead = new Set<Uuid>()
  for (const e of events) {
    if (e.supersedes) dead.add(e.supersedes)
    if (e.type === 'conflict.resolved') {
      const p = e.payload as RunEvent<'conflict.resolved'>['payload']
      for (const id of p.rejected_event_ids ?? []) dead.add(id)
    }
  }
  return dead
}

export function allSteps(content: RevisionContent): Step[] {
  return content.sections.flatMap((s) => s.steps)
}

export function findStep(content: RevisionContent, stepId: Uuid): Step | null {
  for (const s of content.sections) for (const st of s.steps) if (st.id === stepId) return st
  return null
}

export function findInput(step: Step, inputId: Uuid): Input | null {
  return step.inputs.find((i) => i.id === inputId) ?? null
}

export interface NcrInfo {
  ncr_id: Uuid
  step_id: Uuid | null
  input_id: Uuid | null
  status: NcrStatus
  raised_event_id: Uuid
}

/** Extra per-step facts used by validation and UI (not part of the wire projection). */
export interface StepDetail {
  /** live events of this step in projection order */
  events: RunEvent[]
  /** latest live completion after the last reopen */
  completedEvent: RunEvent | null
  /** first live verification after that completion cycle began */
  verifiedEvent: RunEvent | null
  /** current (last live) input.recorded per input */
  inputEvents: Map<Uuid, RunEvent<'input.recorded'>>
}

export interface ProjectionDetail {
  projection: RunProjection
  ordered: RunEvent[]
  live: RunEvent[]
  dead: Set<Uuid>
  ncrs: Map<Uuid, NcrInfo>
  steps: Map<Uuid, StepDetail>
}

function ncrCovers(ncr: NcrInfo, stepId: Uuid, inputId: Uuid | null): boolean {
  if (ncr.step_id !== stepId) return false
  return ncr.input_id == null || ncr.input_id === inputId
}

export function projectRunDetailed(runId: Uuid, content: RevisionContent, events: readonly RunEvent[]): ProjectionDetail {
  const ordered = orderEvents(events.filter((e) => e.run_id === runId))
  const dead = deadEventIds(ordered)
  const live = ordered.filter((e) => !dead.has(e.id))
  const position = new Map<Uuid, number>()
  live.forEach((e, i) => position.set(e.id, i))

  // Rule 9: NCRs, in raise order
  const ncrs = new Map<Uuid, NcrInfo>()
  for (const e of live) {
    if (e.type === 'ncr.raised') {
      const p = e.payload as RunEvent<'ncr.raised'>['payload']
      if (!ncrs.has(p.ncr_id)) {
        ncrs.set(p.ncr_id, { ncr_id: p.ncr_id, step_id: e.step_id, input_id: p.input_id ?? null, status: 'open', raised_event_id: e.id })
      }
    } else if (e.type === 'ncr.dispositioned' || e.type === 'ncr.closed') {
      const n = ncrs.get((e.payload as { ncr_id: Uuid }).ncr_id)
      if (n) n.status = e.type === 'ncr.closed' ? 'closed' : n.status === 'closed' ? 'closed' : 'dispositioned'
    }
  }
  const ncrList = [...ncrs.values()]
  const openNcrIds = ncrList.filter((n) => n.status !== 'closed').map((n) => n.ncr_id)

  const steps = allSteps(content)
  const details = new Map<Uuid, StepDetail>()
  const completed = new Map<Uuid, boolean>()

  // Rule 5 first (completion is needed by depends_on of other steps)
  for (const step of steps) {
    const evs = live.filter((e) => e.step_id === step.id)
    let lastReopen = -1
    for (const e of evs) if (e.type === 'step.reopened') lastReopen = position.get(e.id)!
    const completions = evs.filter((e) => e.type === 'step.completed' && position.get(e.id)! > lastReopen)
    const firstCompletion = completions[0] ?? null
    const lastCompletion = completions[completions.length - 1] ?? null
    const verifiedEvent = firstCompletion
      ? (evs.find((e) => e.type === 'step.verified' && position.get(e.id)! > position.get(firstCompletion.id)!) ?? null)
      : null
    const inputEvents = new Map<Uuid, RunEvent<'input.recorded'>>()
    for (const e of evs) {
      if (e.type === 'input.recorded') {
        const ie = e as RunEvent<'input.recorded'>
        inputEvents.set(ie.payload.input_id, ie)
      }
    }
    details.set(step.id, { events: evs, completedEvent: lastCompletion, verifiedEvent, inputEvents })
    completed.set(step.id, lastCompletion !== null)
  }

  const stepProjections: Record<Uuid, StepProjection> = {}
  let anyBlockingForRun = false

  for (const step of steps) {
    const d = details.get(step.id)!
    const isCompleted = completed.get(step.id)!

    // Rule 4: conflict flag on a live event without a later conflict.resolved for the step
    let lastResolved = -1
    for (const e of d.events) if (e.type === 'conflict.resolved') lastResolved = position.get(e.id)!
    const inConflict = d.events.some((e) => (e.flags ?? []).includes('conflict') && position.get(e.id)! > lastResolved)

    // Rule 3: inputs
    const inputs: Record<Uuid, InputProjection> = {}
    for (const input of step.inputs) {
      const ev = d.inputEvents.get(input.id) ?? null
      const value: InputValue | null = ev ? ev.payload.value : null
      const competing = inConflict
        ? d.events
            .filter((e) => e.type === 'input.recorded' && (e as RunEvent<'input.recorded'>).payload.input_id === input.id && position.get(e.id)! > lastResolved)
            .map((e) => e.id)
        : []
      inputs[input.id] = {
        input_id: input.id,
        value,
        event_id: ev?.id ?? null,
        out_of_tolerance: input.type === 'number' && ev !== null && isOutOfTolerance(value, input),
        competing_event_ids: competing.length > 1 ? competing : [],
      }
    }

    // Rule 7: block reasons, only for steps not completed
    const reasons = new Set<BlockReason>()
    if (!isCompleted) {
      for (const dep of step.depends_on) if (!completed.get(dep)) reasons.add('depends_on')
      for (const input of step.inputs) {
        const ip = inputs[input.id]!
        const covered = ncrList.some((n) => ncrCovers(n, step.id, input.id))
        if (covered) continue
        if (ip.out_of_tolerance) reasons.add('out_of_tolerance')
        const flags = d.inputEvents.get(input.id)?.flags ?? []
        if (flags.includes('tool_expired')) reasons.add('tool_expired')
        if (flags.includes('tool_unknown')) reasons.add('tool_unknown')
      }
    }
    const blockReasons = [...reasons].sort()

    // Rule 8
    let state: StepState
    if (inConflict) state = 'conflict'
    else if (isCompleted && d.verifiedEvent) state = 'verified'
    else if (isCompleted) state = 'completed'
    else if (blockReasons.length) state = 'blocked'
    else if (d.events.length) state = 'in_progress'
    else state = 'pending'

    if (state === 'conflict' || blockReasons.some((r) => r !== 'depends_on')) anyBlockingForRun = true

    stepProjections[step.id] = {
      step_id: step.id,
      state,
      block_reasons: blockReasons,
      inputs,
      completed_by: d.completedEvent?.actor_id ?? null,
      completed_at: d.completedEvent?.client_ts ?? null,
      verified_by: d.verifiedEvent?.actor_id ?? null,
      verified_at: d.verifiedEvent?.client_ts ?? null,
      open_ncr_ids: ncrList.filter((n) => n.step_id === step.id && n.status !== 'closed').map((n) => n.ncr_id),
    }
  }

  // Rule 10
  let status: RunStatus
  if (live.some((e) => e.type === 'run.aborted')) status = 'aborted'
  else if (live.some((e) => e.type === 'run.completed')) status = 'completed'
  else if (anyBlockingForRun) status = 'blocked'
  else status = 'active'

  // Rule 11
  const canComplete =
    status === 'active' &&
    steps.every((s) => {
      const st = stepProjections[s.id]!.state
      if (s.verification?.required) return st === 'verified'
      return st === 'completed' || st === 'verified'
    }) &&
    openNcrIds.length === 0

  return {
    projection: { run_id: runId, status, steps: stepProjections, open_ncr_ids: openNcrIds, can_complete: canComplete },
    ordered,
    live,
    dead,
    ncrs,
    steps: details,
  }
}

export function projectRun(runId: Uuid, content: RevisionContent, events: readonly RunEvent[]): RunProjection {
  return projectRunDetailed(runId, content, events).projection
}
