// Pure helpers for the as-run record: why an event is dead (§4 rule 2) and a display summary per event.
// Dead events stay in the record — an auditor must see what was corrected and by what.
import type { Input, InputValue, RevisionContent, RunEvent, Step, Uuid } from '../../domain/types'
import { allSteps, findInput, orderEvents } from '../../domain/projection'

export type DeadReason = { kind: 'superseded'; by: Uuid } | { kind: 'rejected'; by: Uuid }

export function deadReasons(events: readonly RunEvent[]): Map<Uuid, DeadReason> {
  const out = new Map<Uuid, DeadReason>()
  for (const e of orderEvents(events)) {
    if (e.supersedes && !out.has(e.supersedes)) out.set(e.supersedes, { kind: 'superseded', by: e.id })
    if (e.type === 'conflict.resolved') {
      const p = e.payload as RunEvent<'conflict.resolved'>['payload']
      for (const id of p.rejected_event_ids ?? []) if (!out.has(id)) out.set(id, { kind: 'rejected', by: e.id })
    }
  }
  return out
}

/** One line of event detail: i18n key under st.quality.record.detail.* plus params. */
export interface DetailLine {
  key: string
  params: Record<string, string | number>
}

export function formatValue(input: Input | null, value: InputValue | null | undefined): string {
  if (value == null) return '—'
  if (value === true) return '✓'
  if (Array.isArray(value)) return String(value.length)
  if (input?.type === 'number' && input.unit) return `${value} ${input.unit}`
  return value
}

export function stepIndex(content: RevisionContent | null): Map<Uuid, { step: Step; number: string }> {
  const out = new Map<Uuid, { step: Step; number: string }>()
  content?.sections.forEach((sec, si) => sec.steps.forEach((step, i) => out.set(step.id, { step, number: `${si + 1}.${i + 1}` })))
  return out
}

export function eventDetails(e: RunEvent, content: RevisionContent | null, ncrNumber: (id: Uuid) => string): DetailLine[] {
  const p = e.payload as Record<string, unknown>
  const step = content && e.step_id ? (allSteps(content).find((s) => s.id === e.step_id) ?? null) : null
  switch (e.type) {
    case 'run.created':
      return [
        { key: 'serial', params: { v: String(p.serial ?? '') } },
        ...(p.work_order ? [{ key: 'workOrder', params: { v: String(p.work_order) } }] : []),
      ]
    case 'input.recorded': {
      const input = step ? findInput(step, p.input_id as Uuid) : null
      const value = p.value as InputValue
      const lines: DetailLine[] = [{
        key: Array.isArray(value) ? 'photos' : 'value',
        params: { label: input?.label ?? String(p.input_id), v: formatValue(input, value) },
      }]
      lines.push({ key: 'source', params: { v: String(p.source ?? 'manual') } })
      if (p.ocr_raw) lines.push({ key: 'ocrRaw', params: { v: String(p.ocr_raw) } })
      return lines
    }
    case 'step.reopened':
    case 'run.aborted':
      return [{ key: 'reason', params: { v: String(p.reason ?? '') } }]
    case 'note.added':
      return [{ key: p.system === 'lock_takeover' ? 'lockTakeover' : 'note', params: { v: String(p.text ?? '') } }]
    case 'ncr.raised':
      return [{ key: 'ncrRaised', params: { n: ncrNumber(p.ncr_id as Uuid), v: String(p.description ?? '') } }]
    case 'ncr.dispositioned':
      return [{ key: 'ncrDispositioned', params: { n: ncrNumber(p.ncr_id as Uuid), d: String(p.disposition ?? ''), v: String(p.note ?? '') } }]
    case 'ncr.closed':
      return [{ key: 'ncrClosed', params: { n: ncrNumber(p.ncr_id as Uuid) } }]
    case 'conflict.resolved':
      return [{
        key: 'conflictResolved',
        params: {
          kept: ((p.kept_event_ids as Uuid[] | undefined) ?? []).length,
          rejected: ((p.rejected_event_ids as Uuid[] | undefined) ?? []).length,
          v: String(p.reason ?? ''),
        },
      }]
    default:
      return []
  }
}

/** Scanned identifiers per entity (parts and tools) from live input events, for the record's traceability list. */
export interface ScanRecord {
  event: RunEvent<'input.recorded'>
  step: Step
  input: Input & { type: 'scan' }
  value: string
  dead: boolean
}

export function scanRecords(content: RevisionContent | null, events: readonly RunEvent[], dead: ReadonlySet<Uuid>): ScanRecord[] {
  if (!content) return []
  const steps = new Map(allSteps(content).map((s) => [s.id, s]))
  const out: ScanRecord[] = []
  for (const e of orderEvents(events)) {
    if (e.type !== 'input.recorded' || !e.step_id) continue
    const step = steps.get(e.step_id)
    const p = e.payload as RunEvent<'input.recorded'>['payload']
    const input = step ? findInput(step, p.input_id) : null
    if (!step || !input || input.type !== 'scan' || typeof p.value !== 'string') continue
    out.push({ event: e as RunEvent<'input.recorded'>, step, input, value: p.value, dead: dead.has(e.id) })
  }
  return out
}
