// QR target → where the tablet should go (ARCHITECTURE §9). Pure so the routing rules can be tested
// without a router or stores; useQrNavigation wires it to the real ones.
import { resolveWorkstationStep } from '../../domain/workstation'
import type { QrTarget, RevisionContent, Run, RunProjection, Uuid } from '../../domain/types'

export interface QrContext {
  runs: readonly Run[]
  activeRunId: Uuid | null
  /** runs checked out to this device (preferred when several runs share a workstation) */
  deviceRunIds: ReadonlySet<Uuid>
  contentOf(run: Run): RevisionContent | null
  projectionOf(run: Run): RunProjection | null
}

export type QrNavTarget =
  | { name: 'st-run'; params: { runId: Uuid } }
  | { name: 'st-run-step'; params: { runId: Uuid; stepId: Uuid } }

export type QrResolution =
  | { type: 'navigate'; to: QrNavTarget }
  /** the run has steps at this workstation but none is actionable right now */
  | { type: 'choose-step'; run: Run; code: string; stepIds: Uuid[] }
  /** several (or not the active) runs match: the operator picks one */
  | { type: 'choose-run'; reason: 'workstation' | 'part'; code: string; runs: Run[] }
  | { type: 'workstation-none'; code: string }
  | { type: 'part-none'; part_number: string; serial: string }
  | { type: 'tool'; code: string }
  | { type: 'unknown'; raw: string }

const OPEN = new Set(['active', 'blocked'])

function hasLocation(content: RevisionContent | null, code: string): boolean {
  if (!content) return false
  const norm = code.trim().toLowerCase()
  return content.sections.some((s) => s.steps.some((st) => st.locations.some((l) => l.trim().toLowerCase() === norm)))
}

/** Resolve a workstation code within one run: first actionable step, else the list of its steps there. */
export function resolveWorkstationInRun(run: Run, code: string, ctx: QrContext): QrResolution {
  const content = ctx.contentOf(run)
  if (!content) return { type: 'navigate', to: { name: 'st-run', params: { runId: run.id } } }
  const m = resolveWorkstationStep(content, ctx.projectionOf(run), code)
  if (m.step_id) return { type: 'navigate', to: { name: 'st-run-step', params: { runId: run.id, stepId: m.step_id } } }
  return { type: 'choose-step', run, code, stepIds: m.candidates }
}

function byPreference(ctx: QrContext) {
  return (a: Run, b: Run) => {
    const da = ctx.deviceRunIds.has(a.id) ? 0 : 1
    const db = ctx.deviceRunIds.has(b.id) ? 0 : 1
    if (da !== db) return da - db
    return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
  }
}

export function resolveQr(target: QrTarget, ctx: QrContext): QrResolution {
  switch (target.kind) {
    case 'run':
      // even if this device does not know the run yet, the run page explains that (and it may arrive by sync)
      return { type: 'navigate', to: { name: 'st-run', params: { runId: target.run_id } } }

    case 'tool':
      return { type: 'tool', code: target.code }

    case 'part': {
      const serial = target.serial.trim().toLowerCase()
      const matches = ctx.runs.filter((r) => r.serial.trim().toLowerCase() === serial)
      if (!matches.length) return { type: 'part-none', part_number: target.part_number, serial: target.serial }
      const open = matches.filter((r) => OPEN.has(r.status))
      if (open.length === 1) return { type: 'navigate', to: { name: 'st-run', params: { runId: open[0]!.id } } }
      if (!open.length && matches.length === 1) return { type: 'navigate', to: { name: 'st-run', params: { runId: matches[0]!.id } } }
      return { type: 'choose-run', reason: 'part', code: target.serial, runs: [...matches].sort(byPreference(ctx)) }
    }

    case 'workstation': {
      const code = target.code
      const candidates = ctx.runs.filter((r) => OPEN.has(r.status) && hasLocation(ctx.contentOf(r), code))
      const active = ctx.activeRunId ? candidates.find((r) => r.id === ctx.activeRunId) : undefined
      if (active) return resolveWorkstationInRun(active, code, ctx)
      if (!candidates.length) return { type: 'workstation-none', code }
      const activeIsOpen = ctx.activeRunId ? ctx.runs.some((r) => r.id === ctx.activeRunId && OPEN.has(r.status)) : false
      // no run selected on this tablet and only one fits: go there. If the tablet is working on another
      // run, switching runs must be a conscious choice, so ask even when only one candidate exists.
      if (candidates.length === 1 && !activeIsOpen) return resolveWorkstationInRun(candidates[0]!, code, ctx)
      return { type: 'choose-run', reason: 'workstation', code, runs: [...candidates].sort(byPreference(ctx)) }
    }

    case 'unknown':
      return { type: 'unknown', raw: target.raw }
  }
}
