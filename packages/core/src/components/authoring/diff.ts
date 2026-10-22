// Step-level diff between two revisions, matched by step id (ids are stable across revisions for the
// "same" step). Approvers review exactly this, so "changed" is strict: any difference in a field,
// an input, the section a step belongs to or its relative order counts.
import type { Input, RevisionContent, Section, Step, Uuid } from '../../domain/types'

export type StepField = 'title' | 'instructions' | 'media' | 'locations' | 'depends_on' | 'verification' | 'section' | 'order' | 'inputs'

export interface InputChange {
  input_id: Uuid
  label: string
  kind: 'added' | 'removed' | 'changed'
  /** for 'changed': names of differing fields (label, required, type, unit, min, ...) and 'order' */
  fields: string[]
}

export interface StepRef {
  step_id: Uuid
  title: string
  section_title: string
}

export interface StepChange extends StepRef {
  fields: StepField[]
  inputs: InputChange[]
  before: Step
  after: Step
}

export interface RevisionDiff {
  added: StepRef[]
  removed: StepRef[]
  changed: StepChange[]
  unchanged: number
  /** section titles renamed (by section id) — not a step change, but approvers should see it */
  renamed_sections: Array<{ section_id: Uuid; before: string; after: string }>
}

interface Located {
  step: Step
  section: Section
}

function locate(content: RevisionContent | null): Map<Uuid, Located> {
  const out = new Map<Uuid, Located>()
  for (const section of content?.sections ?? []) for (const step of section.steps) out.set(step.id, { step, section })
  return out
}

/** null and undefined (absent) mean the same in content; everything else compares structurally. */
function same(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => same(x, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ra = a as Record<string, unknown>
    const rb = b as Record<string, unknown>
    const keys = new Set([...Object.keys(ra), ...Object.keys(rb)])
    return [...keys].every((k) => same(ra[k], rb[k]))
  }
  return a === b
}

/** Ids of `after` outside a longest common subsequence with `before` — i.e. the ones that moved. */
export function movedIds(before: readonly Uuid[], after: readonly Uuid[]): Set<Uuid> {
  const n = before.length
  const m = after.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = before[i] === after[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const keep = new Set<Uuid>()
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      keep.add(before[i]!)
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
    else j++
  }
  return new Set(after.filter((id) => !keep.has(id)))
}

const INPUT_FIELDS = ['type', 'label', 'required', 'multiline', 'unit', 'min', 'nominal', 'max', 'decimals', 'ocr', 'min_count', 'max_count', 'entity', 'expect', 'role']

export function diffInputs(before: readonly Input[], after: readonly Input[]): InputChange[] {
  const b = new Map(before.map((i) => [i.id, i]))
  const a = new Map(after.map((i) => [i.id, i]))
  const common = (list: readonly Input[], other: Map<Uuid, Input>) => list.filter((i) => other.has(i.id)).map((i) => i.id)
  const moved = movedIds(common(before, a), common(after, b))
  const out: InputChange[] = []
  for (const inp of after) {
    const old = b.get(inp.id)
    if (!old) {
      out.push({ input_id: inp.id, label: inp.label, kind: 'added', fields: [] })
      continue
    }
    const ro = old as unknown as Record<string, unknown>
    const rn = inp as unknown as Record<string, unknown>
    const extra = Object.keys({ ...ro, ...rn }).filter((k) => k !== 'id' && !INPUT_FIELDS.includes(k))
    const fields = [...INPUT_FIELDS, ...extra].filter((f) => !same(ro[f], rn[f]))
    if (moved.has(inp.id)) fields.push('order')
    if (fields.length) out.push({ input_id: inp.id, label: inp.label, kind: 'changed', fields })
  }
  for (const inp of before) if (!a.has(inp.id)) out.push({ input_id: inp.id, label: inp.label, kind: 'removed', fields: [] })
  return out
}

export function diffRevisions(before: RevisionContent | null, after: RevisionContent): RevisionDiff {
  const b = locate(before)
  const a = locate(after)
  const ref = (l: Located): StepRef => ({ step_id: l.step.id, title: l.step.title, section_title: l.section.title })

  const commonBefore = [...b.keys()].filter((id) => a.has(id))
  const commonAfter = [...a.keys()].filter((id) => b.has(id))
  const moved = movedIds(commonBefore, commonAfter)

  const diff: RevisionDiff = { added: [], removed: [], changed: [], unchanged: 0, renamed_sections: [] }
  for (const [id, now] of a) {
    const old = b.get(id)
    if (!old) {
      diff.added.push(ref(now))
      continue
    }
    const fields: StepField[] = []
    for (const f of ['title', 'instructions', 'media', 'locations', 'depends_on'] as const) {
      // depends_on / locations / media are sets semantically, but order is still content — keep strict
      if (!same(old.step[f], now.step[f])) fields.push(f)
    }
    // an absent verification and one with required=false behave identically on the floor
    const ver = (s: Step) => (s.verification?.required ? s.verification : null)
    if (!same(ver(old.step), ver(now.step))) fields.push('verification')
    if (old.section.id !== now.section.id) fields.push('section')
    else if (moved.has(id)) fields.push('order')
    const inputs = diffInputs(old.step.inputs, now.step.inputs)
    if (inputs.length) fields.push('inputs')
    if (fields.length) diff.changed.push({ ...ref(now), fields, inputs, before: old.step, after: now.step })
    else diff.unchanged++
  }
  for (const [id, old] of b) if (!a.has(id)) diff.removed.push(ref(old))

  const oldSections = new Map((before?.sections ?? []).map((s) => [s.id, s.title]))
  for (const s of after.sections) {
    const t = oldSections.get(s.id)
    if (t !== undefined && t !== s.title) diff.renamed_sections.push({ section_id: s.id, before: t, after: s.title })
  }
  return diff
}

export function isEmptyDiff(d: RevisionDiff): boolean {
  return !d.added.length && !d.removed.length && !d.changed.length && !d.renamed_sections.length
}
