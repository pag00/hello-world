// Workstation QR → step (ARCHITECTURE §9): among the steps of the device's active run whose `locations`
// include the scanned code, pick the first actionable one in procedure order.
import { allSteps } from './projection'
import type { RevisionContent, RunProjection, StepState, Uuid } from './types'

// in_progress first (resume what was started), then pending, then blocked by something the operator can
// see and act on (out of tolerance → raise NCR); finished or conflicted steps are not actionable.
const PRIORITY: Partial<Record<StepState, number>> = { in_progress: 0, pending: 1, blocked: 2 }

export interface WorkstationMatch {
  /** best step to open, or null when no step at this workstation is actionable */
  step_id: Uuid | null
  /** all steps at this workstation, procedure order */
  candidates: Uuid[]
}

export function resolveWorkstationStep(content: RevisionContent, projection: RunProjection | null, code: string): WorkstationMatch {
  const norm = code.trim().toLowerCase()
  const candidates = allSteps(content).filter((s) => s.locations.some((l) => l.trim().toLowerCase() === norm)).map((s) => s.id)
  let best: Uuid | null = null
  let bestRank = Infinity
  for (const id of candidates) {
    const sp = projection?.steps[id]
    const state: StepState = sp?.state ?? 'pending'
    const rank = PRIORITY[state]
    if (rank === undefined) continue
    // a step only waiting for its dependencies is not actionable yet
    if (state === 'blocked' && sp!.block_reasons.every((r) => r === 'depends_on')) continue
    if (rank < bestRank) {
      best = id
      bestRank = rank
    }
  }
  return { step_id: best, candidates }
}
