import { describe, expect, it } from 'vitest'
import type { Input, ProcedureRevision, RevisionContent, Step, User } from '../../domain/types'
import { cyclicSteps, findCycle, wouldCreateCycle, dependentsOf } from './graph'
import { validateContent, checkExpect, hasErrors, canSubmit, type Issue } from './validation'
import { diffRevisions, diffInputs, movedIds, isEmptyDiff } from './diff'
import {
  changeInputType, cleanContent, moveStep, newInput, newSection, newStep, removeSection, removeStep, stepNumbers,
} from './contentOps'
import { baselineOf, revisionActions, sortRevisions, shortHash, canCreateRevision } from './revisions'

function step(id: string, deps: string[] = [], extra: Partial<Step> = {}): Step {
  return { id, title: `Step ${id}`, instructions: '', media: [], locations: [], depends_on: deps, verification: null, inputs: [], ...extra }
}

function content(...sections: Array<{ id: string; steps: Step[]; title?: string }>): RevisionContent {
  return { schema: 1, sections: sections.map((s) => ({ id: s.id, title: s.title ?? `Section ${s.id}`, steps: s.steps })) }
}

const chk = (id: string, label = 'ok'): Input => ({ id, label, required: true, type: 'check' })

function num(over: Partial<Extract<Input, { type: 'number' }>> = {}): Extract<Input, { type: 'number' }> {
  return { id: 'n1', label: 'Torque', required: true, type: 'number', unit: 'Nm', decimals: 1, ocr: false, ...over }
}

const keys = (issues: Issue[]) => issues.map((i) => i.key)
const errorKeys = (issues: Issue[]) => issues.filter((i) => i.severity === 'error').map((i) => i.key)

// ---------------------------------------------------------------------------

describe('cycle detection', () => {
  it('accepts a DAG', () => {
    const c = content({ id: 's', steps: [step('a'), step('b', ['a']), step('c', ['a', 'b'])] })
    expect(findCycle(c)).toBeNull()
  })

  it('finds a self loop', () => {
    expect(findCycle(content({ id: 's', steps: [step('a', ['a'])] }))).toEqual(['a', 'a'])
  })

  it('finds a long cycle across sections and returns it in order', () => {
    const c = content(
      { id: 's1', steps: [step('a', ['c']), step('x')] },
      { id: 's2', steps: [step('b', ['a']), step('c', ['b', 'x'])] },
    )
    const cyc = findCycle(c)!
    expect(cyc[0]).toBe(cyc[cyc.length - 1])
    expect(new Set(cyc)).toEqual(new Set(['a', 'b', 'c']))
    // each element depends on the next
    const byId = new Map(c.sections.flatMap((s) => s.steps).map((s) => [s.id, s]))
    for (let i = 0; i < cyc.length - 1; i++) expect(byId.get(cyc[i]!)!.depends_on).toContain(cyc[i + 1])
  })

  it('ignores dangling references (reported by validation instead)', () => {
    expect(findCycle(content({ id: 's', steps: [step('a', ['gone'])] }))).toBeNull()
  })

  it('wouldCreateCycle: direct, transitive and self', () => {
    const c = content({ id: 's', steps: [step('a'), step('b', ['a']), step('c', ['b']), step('d')] })
    expect(wouldCreateCycle(c, 'a', 'c')).toBe(true) // c → b → a
    expect(wouldCreateCycle(c, 'a', 'b')).toBe(true)
    expect(wouldCreateCycle(c, 'a', 'a')).toBe(true)
    expect(wouldCreateCycle(c, 'c', 'a')).toBe(false) // already implied, not a cycle
    expect(wouldCreateCycle(c, 'd', 'c')).toBe(false)
    expect(dependentsOf(c, 'a')).toEqual(new Set(['b', 'c']))
  })

  it('cyclicSteps lists every step on any cycle, not just the first one found', () => {
    const c = content({ id: 's', steps: [step('a', ['b']), step('b', ['a']), step('c', ['d']), step('d', ['c', 'a']), step('e', ['a']), step('f', ['f'])] })
    expect(cyclicSteps(c)).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('handles a deep chain without recursion limits', () => {
    const steps = Array.from({ length: 5000 }, (_, i) => step(`s${i}`, i ? [`s${i - 1}`] : []))
    const c = content({ id: 's', steps })
    expect(findCycle(c)).toBeNull()
    steps[0]!.depends_on = ['s4999']
    expect(findCycle(c)!.length).toBe(5001)
  })
})

// ---------------------------------------------------------------------------

describe('editor validation', () => {
  const wrap = (inputs: Input[], extra: Partial<Step> = {}) => content({ id: 's', steps: [step('a', [], { inputs, ...extra })] })

  it('a complete, valid procedure has no blocking issues', () => {
    const issues = validateContent(wrap([num({ min: '11.5', nominal: '12.0', max: '12.5' })]), { workstations: [] })
    expect(hasErrors(issues)).toBe(false)
    expect(canSubmit(issues)).toBe(true)
  })

  it('empty procedure and blank titles are incomplete, not errors', () => {
    const issues = validateContent({ schema: 1, sections: [] })
    expect(keys(issues)).toEqual(['noSteps'])
    expect(hasErrors(issues)).toBe(false)
    expect(canSubmit(issues)).toBe(false)

    const blank = content({ id: 's', title: ' ', steps: [step('a', [], { title: '', inputs: [chk('i', '')] })] })
    const b = validateContent(blank)
    expect(keys(b).sort()).toEqual(['inputLabel', 'sectionTitle', 'stepTitle'])
    expect(b.every((i) => i.severity === 'incomplete')).toBe(true)
  })

  it.each([
    ['12.5', true], ['-0.25', true], ['0', true], ['12', true],
    ['12,5', false], ['+3', false], ['.5', false], ['7.', false], ['1e3', false], [' 1', false], ['abc', false], ['-.5', false],
  ])('limit %j valid=%s', (v, ok) => {
    const e = errorKeys(validateContent(wrap([num({ decimals: 2, min: v })])))
    expect(e.includes('invalidDecimal')).toBe(!ok)
  })

  it('min ≤ nominal ≤ max with exact decimal comparison', () => {
    expect(errorKeys(validateContent(wrap([num({ min: '12.50', max: '12.5' })])))).toEqual([]) // equal is fine
    expect(errorKeys(validateContent(wrap([num({ min: '12.6', max: '12.5' })])))).toEqual(['limitOrder'])
    expect(errorKeys(validateContent(wrap([num({ min: '10', nominal: '9.9' })])))).toEqual(['nominalOutside'])
    expect(errorKeys(validateContent(wrap([num({ max: '10', nominal: '10.1' })])))).toEqual(['nominalOutside'])
    expect(errorKeys(validateContent(wrap([num({ min: '-1', nominal: '-1', max: '-1' })])))).toEqual([])
    // compares numerically, not as strings ("9" > "10" lexically)
    expect(errorKeys(validateContent(wrap([num({ decimals: 0, min: '9', max: '10' })])))).toEqual([])
  })

  it('decimals must be a non-negative integer (no floats in hashed content)', () => {
    for (const d of [-1, 1.5, Number.NaN, 10]) {
      expect(errorKeys(validateContent(wrap([num({ decimals: d })])))).toContain('decimalsInvalid')
    }
    expect(errorKeys(validateContent(wrap([num({ decimals: 0 })])))).toEqual([])
  })

  it('warns when a limit is finer than the recorded resolution', () => {
    const issues = validateContent(wrap([num({ decimals: 1, max: '12.55' })]))
    expect(issues.find((i) => i.key === 'limitPrecision')).toMatchObject({ severity: 'warning', field: 'max' })
  })

  it('photo counts', () => {
    const photo = (min_count: number, max_count: number | null, required = true): Input => ({ id: 'p', label: 'P', required, type: 'photo', min_count, max_count })
    expect(errorKeys(validateContent(wrap([photo(1, null)])))).toEqual([])
    expect(errorKeys(validateContent(wrap([photo(0, null)])))).toEqual(['minCountRequired'])
    expect(errorKeys(validateContent(wrap([photo(0, null, false)])))).toEqual([])
    expect(errorKeys(validateContent(wrap([photo(3, 2)])))).toEqual(['maxBelowMin'])
    expect(errorKeys(validateContent(wrap([photo(0, 0, false)])))).toEqual(['maxCountInvalid'])
    expect(errorKeys(validateContent(wrap([photo(1.5, null)])))).toEqual(['minCountInvalid'])
  })

  it('scan expect: exact values, valid and invalid regexes', () => {
    expect(checkExpect(null)).toBe('exact')
    expect(checkExpect('PN-123')).toBe('exact')
    expect(checkExpect('/^PN-\\d+$/')).toBe('regex')
    expect(checkExpect('/^pn/i')).toBe('regex')
    expect(checkExpect('/([/')).toBe('invalid')
    expect(checkExpect('/abc')).toBe('unclosed')
    expect(checkExpect('/')).toBe('exact')
    const scan = (expect: string): Input => ({ id: 'x', label: 'S', required: true, type: 'scan', entity: 'part', expect })
    expect(errorKeys(validateContent(wrap([scan('/(unclosed/')])))).toEqual(['regexInvalid'])
    expect(validateContent(wrap([scan('/abc')])).find((i) => i.key === 'regexUnclosed')?.severity).toBe('warning')
  })

  it('dependencies: unknown, self and cycles are errors pointing at the steps', () => {
    const c = content({ id: 's', steps: [step('a', ['b'], { inputs: [chk('1')] }), step('b', ['a'], { inputs: [chk('2')] }), step('c', ['zz', 'c'], { inputs: [chk('3')] })] })
    const issues = validateContent(c)
    expect(issues.filter((i) => i.key === 'cycle').map((i) => i.stepId).sort()).toEqual(['a', 'b'])
    expect(issues.find((i) => i.key === 'unknownDependency')?.stepId).toBe('c')
    expect(issues.find((i) => i.key === 'selfDependency')?.stepId).toBe('c')
  })

  it('duplicate ids across sections, steps and inputs', () => {
    const c = content({ id: 's', steps: [step('a', [], { inputs: [chk('i1'), chk('i1')] }), step('a', [], { inputs: [chk('a')] })] })
    expect(errorKeys(validateContent(c)).filter((k) => k === 'duplicateId')).toHaveLength(3)
  })

  it('unknown workstation codes and invalid roles', () => {
    const c = wrap([chk('i')], { locations: ['WS-01', 'WS-99'], verification: { required: true, role: 'boss' as never } })
    const issues = validateContent(c, { workstations: ['WS-01'] })
    expect(issues.find((i) => i.key === 'unknownLocation')).toMatchObject({ severity: 'warning', params: { code: 'WS-99' } })
    expect(errorKeys(issues)).toEqual(['invalidRole'])
    // registry not loaded → no location check
    expect(validateContent(c).some((i) => i.key === 'unknownLocation')).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('content operations', () => {
  it('removing a step removes it from every depends_on', () => {
    const c = content({ id: 's1', steps: [step('a'), step('b', ['a'])] }, { id: 's2', steps: [step('c', ['a', 'b'])] })
    removeStep(c, 'a')
    expect(c.sections[0]!.steps.map((s) => s.id)).toEqual(['b'])
    expect(c.sections[0]!.steps[0]!.depends_on).toEqual([])
    expect(c.sections[1]!.steps[0]!.depends_on).toEqual(['b'])
  })

  it('removing a section cleans references to its steps', () => {
    const c = content({ id: 's1', steps: [step('a')] }, { id: 's2', steps: [step('c', ['a'])] })
    removeSection(c, 's1')
    expect(c.sections.map((s) => s.id)).toEqual(['s2'])
    expect(c.sections[0]!.steps[0]!.depends_on).toEqual([])
  })

  it('moves steps within and across sections', () => {
    const c = content({ id: 's1', steps: [step('a'), step('b')] }, { id: 's2', steps: [step('c')] })
    expect(moveStep(c, 'a', -1)).toBe(false)
    expect(moveStep(c, 'a', 1)).toBe(true)
    expect(c.sections[0]!.steps.map((s) => s.id)).toEqual(['b', 'a'])
    expect(moveStep(c, 'a', 1)).toBe(true) // crosses into s2 as first step
    expect(c.sections[1]!.steps.map((s) => s.id)).toEqual(['a', 'c'])
    expect(moveStep(c, 'a', -1)).toBe(true) // back into s1 as last step
    expect(c.sections[0]!.steps.map((s) => s.id)).toEqual(['b', 'a'])
    expect(moveStep(c, 'c', 1)).toBe(false)
    expect(stepNumbers(c).get('c')).toBe('2.1')
  })

  it('changing an input type keeps id, label and required', () => {
    const s = step('a', [], { inputs: [chk('i1', 'Torque')] })
    const n = changeInputType(s, 'i1', 'number')!
    expect(n).toMatchObject({ id: 'i1', label: 'Torque', required: true, type: 'number', decimals: 0 })
    expect(s.inputs[0]).toBe(n)
  })

  it('new objects have uuid ids and integer-only fields', () => {
    expect(newSection().id).toMatch(/^[0-9a-f-]{36}$/)
    expect(newStep().depends_on).toEqual([])
    for (const t of ['check', 'text', 'number', 'photo', 'scan', 'signoff'] as const) {
      const i = newInput(t)
      expect(i.type).toBe(t)
      expect(JSON.stringify(i)).not.toMatch(/\d\.\d/)
    }
    expect(newInput('photo', { required: false })).toMatchObject({ min_count: 0 })
  })

  it('cleanContent drops empty optionals and normalises decimal commas', () => {
    const c = content({
      id: 's', steps: [step('a', [], {
        verification: { required: false, role: 'inspector' },
        inputs: [
          num({ min: '', nominal: null, max: ' 12,5 ' }),
          { id: 'sc', label: 'S', required: true, type: 'scan', entity: 'any', expect: '' },
          { id: 'tx', label: 'T', required: true, type: 'text', multiline: false },
        ],
      })],
    })
    const out = cleanContent(c)
    const st = out.sections[0]!.steps[0]!
    expect('verification' in st).toBe(false)
    expect(st.inputs[0]).toEqual({ id: 'n1', label: 'Torque', required: true, type: 'number', unit: 'Nm', decimals: 1, ocr: false, max: '12.5' })
    expect('expect' in st.inputs[1]!).toBe(false)
    expect('multiline' in st.inputs[2]!).toBe(false)
    // source untouched
    expect((c.sections[0]!.steps[0]!.inputs[0] as { max: string }).max).toBe(' 12,5 ')
  })
})

// ---------------------------------------------------------------------------

describe('revision diff', () => {
  const base = () => content(
    { id: 's1', steps: [step('a', [], { inputs: [num({ id: 'i1', min: '1', max: '2' }), chk('i2')] }), step('b', ['a'])] },
    { id: 's2', steps: [step('c'), step('d')] },
  )

  it('identical content → empty diff', () => {
    const d = diffRevisions(base(), base())
    expect(isEmptyDiff(d)).toBe(true)
    expect(d.unchanged).toBe(4)
  })

  it('first revision: everything added', () => {
    const d = diffRevisions(null, base())
    expect(d.added.map((s) => s.step_id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('added, removed and changed steps with the fields that differ', () => {
    const next = base()
    next.sections[0]!.steps[1]!.title = 'Renamed'
    next.sections[0]!.steps[1]!.locations = ['WS-01']
    next.sections[1]!.steps.splice(1, 1) // remove d
    next.sections[1]!.steps.push(step('e'))
    const d = diffRevisions(base(), next)
    expect(d.added.map((s) => s.step_id)).toEqual(['e'])
    expect(d.removed.map((s) => s.step_id)).toEqual(['d'])
    expect(d.changed.map((c) => [c.step_id, c.fields])).toEqual([['b', ['title', 'locations']]])
    expect(d.unchanged).toBe(2)
  })

  it('input level: added, removed, changed limits, order', () => {
    const next = base()
    const a = next.sections[0]!.steps[0]!
    ;(a.inputs[0] as { max: string }).max = '2.5'
    a.inputs.reverse()
    a.inputs.push(chk('i3', 'new'))
    const d = diffRevisions(base(), next)
    const ch = d.changed.find((c) => c.step_id === 'a')!
    expect(ch.fields).toEqual(['inputs'])
    const byId = Object.fromEntries(ch.inputs.map((i) => [i.input_id, i]))
    expect(byId.i3!.kind).toBe('added')
    expect(byId.i1!.fields).toContain('max')
    // one of the two swapped inputs is reported as moved
    expect(ch.inputs.filter((i) => i.fields.includes('order'))).toHaveLength(1)
  })

  it('null and absent optional fields are the same; required=false verification equals none', () => {
    const prev = base()
    const next = base()
    ;(next.sections[0]!.steps[0]!.inputs[0] as { nominal?: string | null }).nominal = null
    next.sections[0]!.steps[1]!.verification = { required: false, role: 'inspector' }
    expect(isEmptyDiff(diffRevisions(prev, next))).toBe(true)
    next.sections[0]!.steps[1]!.verification = { required: true, role: 'inspector' }
    expect(diffRevisions(prev, next).changed[0]!.fields).toEqual(['verification'])
  })

  it('moves: across sections → section, within section → order', () => {
    const next = base()
    const [c] = next.sections[1]!.steps.splice(0, 1)
    next.sections[0]!.steps.unshift(c!) // c moves into s1 at the top
    const d = diffRevisions(base(), next)
    expect(d.changed.map((x) => [x.step_id, x.fields])).toEqual([['c', ['section']]])

    const n2 = base()
    n2.sections[1]!.steps.reverse()
    expect(diffRevisions(base(), n2).changed.map((x) => x.fields)).toEqual([['order']])
  })

  it('reports renamed sections', () => {
    const next = base()
    next.sections[1]!.title = 'Final'
    expect(diffRevisions(base(), next).renamed_sections).toEqual([{ section_id: 's2', before: 'Section s2', after: 'Final' }])
  })

  it('movedIds picks a minimal set', () => {
    expect(movedIds(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'])).toEqual(new Set())
    expect(movedIds(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c'])).toEqual(new Set(['d']))
    expect(diffInputs([], [chk('x')])[0]!.kind).toBe('added')
  })
})

// ---------------------------------------------------------------------------

describe('revision list logic', () => {
  const author: User = { id: 'u-author', name: 'A', roles: ['author'] }
  const approver: User = { id: 'u-appr', name: 'B', roles: ['approver'] }
  const both: User = { id: 'u-author', name: 'A', roles: ['author', 'approver'] }
  const rev = (rev: string, status: ProcedureRevision['status'], over: Partial<ProcedureRevision> = {}): ProcedureRevision => ({
    id: `r${rev}`, procedure_id: 'p', rev, status, content: { schema: 1, sections: [] }, content_hash: null, change_reason: null,
    author_id: 'u-author', created_at: `2026-01-0${rev.charCodeAt(0) - 64}T00:00:00.000Z`, submitted_at: null, released_at: null, obsoleted_at: null, ...over,
  })

  it('orders revision letters A..Z, AA', () => {
    const list = [rev('B', 'draft'), rev('AA', 'draft', { created_at: '2027-01-01T00:00:00.000Z' }), rev('A', 'obsolete')]
    expect(sortRevisions(list).map((r) => r.rev)).toEqual(['A', 'B', 'AA'])
  })

  it('baseline is the latest released/obsolete revision before', () => {
    const all = [rev('A', 'obsolete'), rev('B', 'released'), rev('C', 'in_review')]
    expect(baselineOf(all[2]!, all)?.rev).toBe('B')
    expect(baselineOf(all[1]!, all)?.rev).toBe('A')
    expect(baselineOf(all[0]!, all)).toBeNull()
  })

  it('approve/reject hidden for the author even with approver role', () => {
    const r = rev('B', 'in_review')
    expect(revisionActions(r, [r], both, true)).toMatchObject({ approve: false, reject: false })
    expect(revisionActions(r, [r], approver, true)).toMatchObject({ approve: true, reject: true })
    expect(revisionActions(r, [r], approver, false)).toMatchObject({ approve: false })
  })

  it('edit/submit only on drafts, for authors, online', () => {
    const d = rev('A', 'draft')
    expect(revisionActions(d, [d], author, true)).toMatchObject({ edit: true, submit: true, startRun: false })
    expect(revisionActions(d, [d], approver, true)).toMatchObject({ edit: false, submit: false })
    expect(revisionActions(d, [d], author, false)).toMatchObject({ edit: false })
    const rel = rev('A', 'released')
    expect(revisionActions(rel, [rel], author, true)).toMatchObject({ edit: false, startRun: true, newRevision: true })
  })

  it('no new revision while a draft or review is open', () => {
    expect(canCreateRevision([rev('A', 'released'), rev('B', 'draft')], author, true)).toBe(false)
    expect(canCreateRevision([rev('A', 'released'), rev('B', 'in_review')], author, true)).toBe(false)
    expect(canCreateRevision([rev('A', 'released')], approver, true)).toBe(false)
  })

  it('shortHash', () => {
    expect(shortHash('sha256:abcdef0123456789')).toBe('abcdef012345')
    expect(shortHash(null)).toBe('—')
  })
})
