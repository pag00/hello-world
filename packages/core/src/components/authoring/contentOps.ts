// Editing operations on a draft's RevisionContent. They mutate in place so they work directly on the
// editor's reactive draft; each keeps the content internally consistent (e.g. removing a step also
// removes it from every depends_on, so no dangling reference is ever saved).
import type { Input, InputType, RevisionContent, Section, Step, Uuid } from '../../domain/types'
import { uuidv7 } from '../../domain/uuid'

export const INPUT_TYPES: readonly InputType[] = ['check', 'text', 'number', 'photo', 'scan', 'signoff']

export function emptyContent(): RevisionContent {
  return { schema: 1, sections: [] }
}

export function newSection(title = ''): Section {
  return { id: uuidv7(), title, steps: [] }
}

export function newStep(title = ''): Step {
  return { id: uuidv7(), title, instructions: '', media: [], locations: [], depends_on: [], verification: null, inputs: [] }
}

export function newInput(type: InputType, base?: { id?: Uuid; label?: string; required?: boolean }): Input {
  const common = { id: base?.id ?? uuidv7(), label: base?.label ?? '', required: base?.required ?? true }
  switch (type) {
    case 'check':
      return { ...common, type }
    case 'text':
      return { ...common, type, multiline: false }
    case 'number':
      return { ...common, type, unit: '', decimals: 0, ocr: false }
    case 'photo':
      return { ...common, type, min_count: common.required ? 1 : 0, max_count: null }
    case 'scan':
      return { ...common, type, entity: 'any', expect: null }
    case 'signoff':
      return { ...common, type, role: null }
  }
}

/** Swap an input's type in place, keeping id, label and required (type-specific fields reset). */
export function changeInputType(step: Step, inputId: Uuid, type: InputType): Input | null {
  const i = step.inputs.findIndex((x) => x.id === inputId)
  if (i < 0) return null
  const old = step.inputs[i]!
  if (old.type === type) return old
  const next = newInput(type, { id: old.id, label: old.label, required: old.required })
  step.inputs.splice(i, 1, next)
  return next
}

/** Move arr[index] by delta (−1 up, +1 down). Returns false at the ends. */
export function moveItem<T>(arr: T[], index: number, delta: -1 | 1): boolean {
  const j = index + delta
  if (index < 0 || index >= arr.length || j < 0 || j >= arr.length) return false
  const [item] = arr.splice(index, 1)
  arr.splice(j, 0, item!)
  return true
}

export function locateStep(content: RevisionContent, stepId: Uuid): { section: number; step: number } | null {
  for (let s = 0; s < content.sections.length; s++) {
    const i = content.sections[s]!.steps.findIndex((x) => x.id === stepId)
    if (i >= 0) return { section: s, step: i }
  }
  return null
}

/**
 * Move a step up/down. At the edge of a section it crosses into the neighbouring section (as its last
 * step when moving up, first when moving down), so steps can be regrouped without drag & drop.
 */
export function moveStep(content: RevisionContent, stepId: Uuid, delta: -1 | 1): boolean {
  const at = locateStep(content, stepId)
  if (!at) return false
  const steps = content.sections[at.section]!.steps
  if (moveItem(steps, at.step, delta)) return true
  const target = content.sections[at.section + delta]
  if (!target) return false
  const [step] = steps.splice(at.step, 1)
  if (delta < 0) target.steps.push(step!)
  else target.steps.unshift(step!)
  return true
}

export function removeStep(content: RevisionContent, stepId: Uuid): Step | null {
  const at = locateStep(content, stepId)
  if (!at) return null
  const [removed] = content.sections[at.section]!.steps.splice(at.step, 1)
  for (const sec of content.sections) {
    for (const st of sec.steps) {
      if (st.depends_on.includes(stepId)) st.depends_on = st.depends_on.filter((d) => d !== stepId)
    }
  }
  return removed ?? null
}

export function removeSection(content: RevisionContent, sectionId: Uuid): Section | null {
  const i = content.sections.findIndex((s) => s.id === sectionId)
  if (i < 0) return null
  const section = content.sections[i]!
  for (const st of [...section.steps]) removeStep(content, st.id)
  content.sections.splice(i, 1)
  return section
}

/** Number shown to people for a step: "<section>.<step>", 1-based, in document order. */
export function stepNumbers(content: RevisionContent): Map<Uuid, string> {
  const out = new Map<Uuid, string>()
  content.sections.forEach((sec, si) => sec.steps.forEach((st, i) => out.set(st.id, `${si + 1}.${i + 1}`)))
  return out
}

/**
 * Deep copy with optional fields that are empty dropped, so an untouched field and a cleared one hash
 * the same ("min": null and no "min" would otherwise give different content hashes).
 */
export function cleanContent(content: RevisionContent): RevisionContent {
  const copy = JSON.parse(JSON.stringify(content)) as RevisionContent
  for (const sec of copy.sections) {
    for (const st of sec.steps) {
      if (!st.verification || !st.verification.required) delete st.verification
      for (const inp of st.inputs) {
        const rec = inp as unknown as Record<string, unknown>
        for (const k of ['min', 'nominal', 'max', 'max_count', 'expect', 'role']) {
          if (rec[k] === null || rec[k] === '') delete rec[k]
        }
        if (inp.type === 'text' && !inp.multiline) delete rec.multiline
        if (inp.type === 'number') {
          for (const k of ['min', 'nominal', 'max'] as const) {
            if (typeof inp[k] === 'string') inp[k] = inp[k]!.trim().replace(',', '.')
          }
        }
      }
    }
  }
  return copy
}
