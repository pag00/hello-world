// Pure helpers for moving through a run's steps (procedure order, numbering, "what next").
import type { RevisionContent, RunProjection, Section, Step, StepProjection, Uuid } from '../../domain/types'

export interface StepRef {
  step: Step
  section: Section
  /** "2.3" — section and step position, as printed on the traveller */
  number: string
  index: number
}

export function flattenSteps(content: RevisionContent | null | undefined): StepRef[] {
  if (!content) return []
  const out: StepRef[] = []
  content.sections.forEach((section, si) => {
    section.steps.forEach((step, i) => out.push({ step, section, number: `${si + 1}.${i + 1}`, index: out.length }))
  })
  return out
}

/** Done = nothing left to do on it: completed, and verified when verification is required. */
export function isStepDone(step: Step, sp: StepProjection | undefined): boolean {
  if (!sp) return false
  if (sp.state === 'verified') return true
  return sp.state === 'completed' && !step.verification?.required
}

/** Only waiting for other steps — nothing the operator can do here yet. */
export function onlyWaitingForDeps(sp: StepProjection | undefined): boolean {
  return !!sp && sp.state === 'blocked' && sp.block_reasons.length > 0 && sp.block_reasons.every((r) => r === 'depends_on')
}

/**
 * The step an operator should open next: the first in procedure order that is not done and not merely
 * waiting for dependencies. Steps already started win over untouched ones so work gets finished first.
 */
export function nextStepId(content: RevisionContent | null | undefined, projection: RunProjection | null | undefined): Uuid | null {
  const steps = flattenSteps(content)
  if (!projection) return steps[0]?.step.id ?? null
  const open = steps.filter(({ step }) => {
    const sp = projection.steps[step.id]
    return !isStepDone(step, sp) && !onlyWaitingForDeps(sp)
  })
  const started = open.find(({ step }) => projection.steps[step.id]?.state === 'in_progress')
  return (started ?? open[0])?.step.id ?? null
}

/** Dependencies of a step that are not completed yet (for "waits for …" hints). */
export function pendingDependencies(step: Step, projection: RunProjection | null | undefined, refs: StepRef[]): StepRef[] {
  return step.depends_on
    .filter((id) => {
      const st = projection?.steps[id]?.state
      return st !== 'completed' && st !== 'verified'
    })
    .map((id) => refs.find((r) => r.step.id === id))
    .filter((r): r is StepRef => !!r)
}

export function progressOf(content: RevisionContent | null | undefined, projection: RunProjection | null | undefined): { done: number; total: number } {
  const steps = flattenSteps(content)
  return { done: steps.filter(({ step }) => isStepDone(step, projection?.steps[step.id])).length, total: steps.length }
}
