// Completion checks the UI adds on top of runs.validateComplete. The shared validation only knows tool
// problems through server flags; a tool scanned offline has no flags until sync, so the tablet re-checks
// the scanned code against its local register (at the time of use) and asks for an NCR right away.
import type { Ncr, RunEvent, Step, StepProjection, Uuid } from '../../domain/types'

type CheckTool = (code: string, on?: Date) => { status: 'ok' | 'expired' | 'unknown' | 'inactive' }

export function ncrCoversInput(ncrs: readonly Ncr[], runId: Uuid, stepId: Uuid, inputId: Uuid): boolean {
  return ncrs.some((n) => n.run_id === runId && n.step_id === stepId && (n.input_id == null || n.input_id === inputId))
}

export function offlineToolProblems(args: {
  runId: Uuid
  step: Step
  projection: StepProjection | undefined
  events: readonly RunEvent[]
  ncrs: readonly Ncr[]
  checkTool: CheckTool
}): string[] {
  const { runId, step, projection, events, ncrs, checkTool } = args
  for (const input of step.inputs) {
    if (input.type !== 'scan' || input.entity !== 'tool') continue
    const ip = projection?.inputs[input.id]
    if (!ip?.event_id || typeof ip.value !== 'string') continue
    const ev = events.find((e) => e.id === ip.event_id)
    // accepted events carry the server's verdict in their flags (handled by validateComplete)
    if (!ev || ev.seq != null) continue
    if (checkTool(ip.value, new Date(ev.client_ts)).status === 'ok') continue
    if (ncrCoversInput(ncrs, runId, step.id, input.id)) continue
    return ['st.run.problems.toolNeedsNcr']
  }
  return []
}
