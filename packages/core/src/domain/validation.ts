// ARCHITECTURE §4 "Validation on write". The client runs this before sealing an event so the operator
// gets an immediate, translated explanation; the server repeats it on ingest (422).
// Problems are returned as i18n keys under st.session.validation.*.

import { hasExactDecimals } from './decimal'
import { findInput, findStep, projectRunDetailed, type ProjectionDetail } from './projection'
import type { EventType, Input, Role, RevisionContent, RunEvent, RunEventContent, User, Uuid } from './types'
import { isUuid } from './uuid'

export const V = 'st.session.validation.'

export class ValidationError extends Error {
  constructor(public readonly keys: string[]) {
    super(`validation failed: ${keys.join(', ')}`)
    this.name = 'ValidationError'
  }
}

export type ToolCheck = { status: 'ok' | 'expired' | 'unknown' | 'inactive' }

export interface ValidationContext {
  content: RevisionContent
  /** all known events of the run (any order) */
  events: readonly RunEvent[]
  actor: User
  /** online → tool calibration problems block; offline → allowed, the server flags on ingest */
  online: boolean
  checkTool?: (code: string) => ToolCheck
  /** reuse an already computed projection of exactly these events */
  detail?: ProjectionDetail
}

const SUPERVISOR_ONLY: EventType[] = ['step.reopened', 'ncr.dispositioned', 'ncr.closed', 'conflict.resolved', 'run.aborted']
const STEP_TYPES: EventType[] = ['step.started', 'input.recorded', 'step.completed', 'step.verified', 'step.reopened', 'conflict.resolved']
const RUN_TYPES: EventType[] = ['run.created', 'run.completed', 'run.aborted']
const DISPOSITIONS = ['use_as_is', 'rework', 'repair', 'scrap', 'return_to_supplier']
const SHA_REF = /^sha256:[0-9a-f]{64}$/

export function hasRole(user: User, role: Role): boolean {
  return user.roles.includes(role)
}

function canOperate(user: User): boolean {
  return hasRole(user, 'operator') || hasRole(user, 'inspector') || hasRole(user, 'supervisor')
}

/** "/regex/" or exact match, per ScanInput.expect. An invalid regex never matches. */
export function matchesExpect(value: string, expect: string | null | undefined): boolean {
  if (expect == null || expect === '') return true
  const m = /^\/(.*)\/([a-z]*)$/s.exec(expect)
  if (m) {
    try {
      return new RegExp(m[1]!, m[2]!.replace(/[gy]/g, '')).test(value)
    } catch {
      return false
    }
  }
  return value === expect
}

function nonEmpty(s: unknown): boolean {
  return typeof s === 'string' && s.trim() !== ''
}

/** Value shape/type checks for an input.recorded value; returns keys. */
export function validateInputValue(input: Input, value: unknown, ctx: Pick<ValidationContext, 'actor' | 'online' | 'checkTool'>): string[] {
  const out: string[] = []
  switch (input.type) {
    case 'check':
      if (value !== true) out.push(V + 'invalidValue')
      break
    case 'text':
      if (typeof value !== 'string') out.push(V + 'invalidValue')
      else if (!nonEmpty(value)) out.push(V + 'emptyValue')
      break
    case 'number':
      if (typeof value !== 'string') out.push(V + 'invalidNumber')
      else if (!hasExactDecimals(value, input.decimals)) out.push(V + 'invalidNumber')
      break
    case 'photo':
      if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && SHA_REF.test(v))) {
        out.push(V + 'invalidPhotos')
      } else if (input.max_count != null && value.length > input.max_count) {
        out.push(V + 'tooManyPhotos')
      }
      break
    case 'scan':
      if (!nonEmpty(value)) out.push(V + 'emptyValue')
      else {
        if (!matchesExpect(value as string, input.expect)) out.push(V + 'scanMismatch')
        if (input.entity === 'tool' && ctx.online && ctx.checkTool) {
          const r = ctx.checkTool(value as string).status
          if (r === 'expired') out.push(V + 'toolExpired')
          else if (r === 'unknown') out.push(V + 'toolUnknown')
          else if (r === 'inactive') out.push(V + 'toolInactive')
        }
      }
      break
    case 'signoff':
      if (value !== true) out.push(V + 'invalidValue')
      if (input.role && !hasRole(ctx.actor, input.role)) out.push(V + 'signoffRole')
      break
  }
  return out
}

/** True when the input currently has a value that satisfies "required" (photo: ≥ min_count). */
export function hasRequiredValue(input: Input, value: unknown): boolean {
  if (value === null || value === undefined) return false
  switch (input.type) {
    case 'check':
    case 'signoff':
      return value === true
    case 'photo':
      return Array.isArray(value) && value.length >= Math.max(1, input.min_count ?? 1)
    default:
      return nonEmpty(value)
  }
}

/** Problems that prevent completing a step (independent of who completes it). */
export function completionProblems(detail: ProjectionDetail, content: RevisionContent, stepId: Uuid): string[] {
  const step = findStep(content, stepId)
  if (!step) return [V + 'unknownStep']
  const sp = detail.projection.steps[stepId]!
  const out: string[] = []
  if (sp.state === 'completed' || sp.state === 'verified') out.push(V + 'alreadyCompleted')
  if (sp.state === 'conflict') out.push(V + 'stepInConflict')
  for (const input of step.inputs) {
    if (input.required && !hasRequiredValue(input, sp.inputs[input.id]?.value ?? null)) {
      out.push(V + (input.type === 'photo' ? 'missingPhotos' : 'missingRequired'))
      break
    }
  }
  if (sp.block_reasons.includes('out_of_tolerance')) out.push(V + 'outOfToleranceNeedsNcr')
  if (sp.block_reasons.includes('tool_expired') || sp.block_reasons.includes('tool_unknown')) out.push(V + 'toolNeedsNcr')
  return [...new Set(out)]
}

/** Validate an event about to be created for an existing run (run.created: see validateRunCreation). */
export function validateEvent(ctx: ValidationContext, ev: RunEventContent): string[] {
  const out: string[] = []
  const detail = ctx.detail ?? projectRunDetailed(ev.run_id, ctx.content, ctx.events)
  const proj = detail.projection
  const actor = ctx.actor

  if (proj.status === 'completed' || proj.status === 'aborted') return [V + 'runClosed']

  // roles
  if (SUPERVISOR_ONLY.includes(ev.type)) {
    if (!hasRole(actor, 'supervisor')) out.push(V + 'roleSupervisor')
  } else if (ev.type === 'run.completed') {
    if (!hasRole(actor, 'inspector') && !hasRole(actor, 'supervisor')) out.push(V + 'roleCompleteRun')
  } else if (!canOperate(actor)) {
    out.push(V + 'roleOperator')
  }

  // structure
  const step = ev.step_id ? findStep(ctx.content, ev.step_id) : null
  if (STEP_TYPES.includes(ev.type) && !step) return [...out, V + 'unknownStep']
  if (RUN_TYPES.includes(ev.type) && ev.step_id !== null) out.push(V + 'invalidValue')
  if (ev.step_id && !step) return [...out, V + 'unknownStep']
  if (ev.supersedes !== null) {
    const target = ctx.events.find((e) => e.id === ev.supersedes)
    if (!target || target.run_id !== ev.run_id) out.push(V + 'unknownSupersedes')
    else if (detail.dead.has(target.id)) out.push(V + 'supersedesDead')
    else if (ev.type === 'input.recorded' && (target.type !== 'input.recorded' || target.step_id !== ev.step_id ||
      (target.payload as { input_id: Uuid }).input_id !== (ev.payload as { input_id: Uuid }).input_id)) {
      out.push(V + 'supersedesMismatch')
    }
  }

  const p = ev.payload as Record<string, unknown>
  switch (ev.type) {
    case 'run.created':
      out.push(V + 'invalidValue')
      break
    case 'input.recorded': {
      const input = findInput(step!, p.input_id as Uuid)
      if (!input) {
        out.push(V + 'unknownInput')
        break
      }
      if (!['manual', 'ocr', 'scan'].includes(p.source as string)) out.push(V + 'invalidValue')
      const sp = proj.steps[step!.id]!
      if (sp.state === 'completed' || sp.state === 'verified') out.push(V + 'stepAlreadyCompleted')
      out.push(...validateInputValue(input, p.value, ctx))
      break
    }
    case 'step.started':
      break
    case 'step.completed':
      out.push(...completionProblems(detail, ctx.content, step!.id))
      break
    case 'step.verified': {
      const sp = proj.steps[step!.id]!
      const d = detail.steps.get(step!.id)!
      if (sp.state === 'verified') out.push(V + 'alreadyVerified')
      else if (sp.state !== 'completed') out.push(V + 'notCompleted')
      const role = step!.verification?.role ?? 'inspector'
      if (!hasRole(actor, role)) out.push(V + 'verifierRole')
      if (d.completedEvent && d.completedEvent.actor_id === actor.id) out.push(V + 'verifierIsCompleter')
      break
    }
    case 'step.reopened': {
      const sp = proj.steps[step!.id]!
      if (sp.state !== 'completed' && sp.state !== 'verified' && sp.state !== 'conflict') out.push(V + 'notCompleted')
      if (!nonEmpty(p.reason)) out.push(V + 'reasonRequired')
      break
    }
    case 'note.added':
      if (!nonEmpty(p.text)) out.push(V + 'textRequired')
      break
    case 'ncr.raised': {
      if (!isUuid(p.ncr_id)) out.push(V + 'invalidValue')
      else if (detail.ncrs.has(p.ncr_id)) out.push(V + 'ncrExists')
      if (!nonEmpty(p.description)) out.push(V + 'descriptionRequired')
      if (p.input_id != null && (!step || !findInput(step, p.input_id as Uuid))) out.push(V + 'unknownInput')
      break
    }
    case 'ncr.dispositioned': {
      const n = detail.ncrs.get(p.ncr_id as Uuid)
      if (!n) out.push(V + 'unknownNcr')
      else if (n.status !== 'open') out.push(V + 'ncrNotOpen')
      if (!DISPOSITIONS.includes(p.disposition as string)) out.push(V + 'dispositionRequired')
      if (!nonEmpty(p.note)) out.push(V + 'noteRequired')
      break
    }
    case 'ncr.closed': {
      const n = detail.ncrs.get(p.ncr_id as Uuid)
      if (!n) out.push(V + 'unknownNcr')
      else if (n.status !== 'dispositioned') out.push(V + 'ncrNotDispositioned')
      break
    }
    case 'conflict.resolved': {
      const keep = p.kept_event_ids as unknown
      const reject = p.rejected_event_ids as unknown
      if (!Array.isArray(keep) || !Array.isArray(reject) || reject.length + keep.length === 0) out.push(V + 'invalidValue')
      else {
        const ids = new Set(ctx.events.filter((e) => e.step_id === ev.step_id).map((e) => e.id))
        if ([...keep, ...reject].some((id) => !ids.has(id as string))) out.push(V + 'unknownEvent')
        if (keep.some((id) => reject.includes(id))) out.push(V + 'invalidValue')
      }
      if (!nonEmpty(p.reason)) out.push(V + 'reasonRequired')
      break
    }
    case 'run.completed':
      if (!proj.can_complete) out.push(V + 'runCannotComplete')
      break
    case 'run.aborted':
      if (!nonEmpty(p.reason)) out.push(V + 'reasonRequired')
      break
  }
  return [...new Set(out)]
}

/** run.created checks (no events yet). */
export function validateRunCreation(args: { actor: User; revisionStatus: string | null; serial: string }): string[] {
  const out: string[] = []
  if (!canOperate(args.actor)) out.push(V + 'roleOperator')
  if (args.revisionStatus === null) out.push(V + 'unknownRevision')
  else if (args.revisionStatus !== 'released') out.push(V + 'revisionNotReleased')
  if (!nonEmpty(args.serial)) out.push(V + 'serialRequired')
  return out
}

/** Every key validation can emit — used by the i18n completeness test. */
export const VALIDATION_KEYS = [
  'runClosed', 'roleSupervisor', 'roleCompleteRun', 'roleOperator', 'unknownStep', 'unknownInput', 'unknownSupersedes',
  'supersedesDead', 'supersedesMismatch', 'invalidValue', 'emptyValue', 'invalidNumber', 'tooManyDecimals', 'invalidPhotos',
  'tooManyPhotos', 'scanMismatch', 'toolExpired', 'toolUnknown', 'toolInactive', 'signoffRole', 'stepAlreadyCompleted',
  'alreadyCompleted', 'stepInConflict', 'missingRequired', 'missingPhotos', 'outOfToleranceNeedsNcr', 'toolNeedsNcr',
  'alreadyVerified', 'notCompleted', 'verifierRole', 'verifierIsCompleter', 'reasonRequired', 'textRequired', 'ncrExists',
  'descriptionRequired', 'unknownNcr', 'ncrNotOpen', 'dispositionRequired', 'noteRequired', 'ncrNotDispositioned',
  'unknownEvent', 'runCannotComplete', 'unknownRevision', 'revisionNotReleased', 'serialRequired', 'unknownRun', 'noUser',
] as const
