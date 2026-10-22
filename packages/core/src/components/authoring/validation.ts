// Authoring-time validation of revision content. Problems carry an i18n key under st.authoring.issues.*
// and point at the section/step/input they concern so the editor can show them in place.
//
// Severity:
//  - error:      the content is malformed (bad decimals, cycles, ...) — cannot be saved or submitted
//  - incomplete: well-formed but not ready for review (no steps, empty titles) — saving a draft is fine,
//                submitting is not
//  - warning:    probably a mistake, never blocks
import { compareDecimal, isDecimal, parseDecimal } from '../../domain/decimal'
import type { Input, RevisionContent, Role, Uuid } from '../../domain/types'
import { cyclicSteps, findCycle, stepsOf } from './graph'

export type IssueSeverity = 'error' | 'incomplete' | 'warning'

export interface Issue {
  severity: IssueSeverity
  /** i18n key, relative: 'st.authoring.issues.' + key */
  key: string
  params?: Record<string, string | number>
  sectionId?: Uuid
  stepId?: Uuid
  inputId?: Uuid
  field?: string
}

export const ISSUE_PREFIX = 'st.authoring.issues.'

export const ISSUE_KEYS = [
  'noSteps', 'emptySection', 'sectionTitle', 'stepTitle', 'inputLabel', 'duplicateId', 'unknownDependency',
  'selfDependency', 'cycle', 'unknownLocation', 'invalidRole', 'invalidDecimal', 'limitOrder', 'nominalOutside',
  'decimalsInvalid', 'limitPrecision', 'minCountInvalid', 'minCountRequired', 'maxCountInvalid', 'maxBelowMin',
  'regexInvalid', 'regexUnclosed', 'entityInvalid', 'noInputs',
] as const

export const ROLES: readonly Role[] = ['operator', 'inspector', 'author', 'approver', 'supervisor', 'admin']
const ENTITIES = ['part', 'tool', 'any']
const MAX_DECIMALS = 9
/** canonical-looking limit: optional '-', digits, optional fraction — no '+', '.5', '7.', exponents or spaces */
const STRICT_DECIMAL = /^-?\d+(\.\d+)?$/

export interface ValidateOptions {
  /** known workstation codes; omit to skip the location check (registry not loaded) */
  workstations?: readonly string[]
}

const blank = (s: unknown) => typeof s !== 'string' || s.trim() === ''
const isNonNegInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/** "/body/flags" → compiled-or-error; anything else is an exact match and always valid. */
export function checkExpect(expect: string | null | undefined): 'exact' | 'regex' | 'invalid' | 'unclosed' {
  if (expect == null || expect === '') return 'exact'
  const m = /^\/(.*)\/([a-z]*)$/s.exec(expect)
  if (!m) return expect.length > 1 && expect.startsWith('/') ? 'unclosed' : 'exact'
  try {
    // the runtime matcher (domain/validation matchesExpect) strips g/y; compile the same way
    new RegExp(m[1]!, m[2]!.replace(/[gy]/g, ''))
    return 'regex'
  } catch {
    return 'invalid'
  }
}

function validateInput(inp: Input, at: Pick<Issue, 'sectionId' | 'stepId' | 'inputId'>, out: Issue[]) {
  const push = (severity: IssueSeverity, key: string, field?: string, params?: Issue['params']) =>
    out.push({ severity, key, field, params, ...at })

  if (blank(inp.label)) push('incomplete', 'inputLabel', 'label')
  switch (inp.type) {
    case 'number': {
      const decimalsOk = isNonNegInt(inp.decimals) && inp.decimals <= MAX_DECIMALS
      if (!decimalsOk) push('error', 'decimalsInvalid', 'decimals', { max: MAX_DECIMALS })
      const limits: Array<['min' | 'nominal' | 'max', string]> = []
      for (const f of ['min', 'nominal', 'max'] as const) {
        const v = inp[f]
        if (v == null || v === '') continue
        // no exponents, no spaces, no thousands separators: the value is hashed and compared exactly
        if (!STRICT_DECIMAL.test(v) || !isDecimal(v)) push('error', 'invalidDecimal', f)
        else limits.push([f, v])
      }
      const get = (f: string) => limits.find(([k]) => k === f)?.[1]
      const min = get('min')
      const nom = get('nominal')
      const max = get('max')
      if (min != null && max != null && compareDecimal(min, max) > 0) push('error', 'limitOrder', 'max')
      if (nom != null && ((min != null && compareDecimal(nom, min) < 0) || (max != null && compareDecimal(nom, max) > 0))) {
        push('error', 'nominalOutside', 'nominal')
      }
      if (decimalsOk) {
        for (const [f, v] of limits) {
          // a limit finer than the recorded resolution can never be hit exactly
          if (parseDecimal(v)!.scale > inp.decimals) push('warning', 'limitPrecision', f, { decimals: inp.decimals })
        }
      }
      break
    }
    case 'photo': {
      if (!isNonNegInt(inp.min_count)) push('error', 'minCountInvalid', 'min_count')
      else if (inp.required && inp.min_count < 1) push('error', 'minCountRequired', 'min_count')
      if (inp.max_count != null) {
        if (!isNonNegInt(inp.max_count) || inp.max_count < 1) push('error', 'maxCountInvalid', 'max_count')
        else if (isNonNegInt(inp.min_count) && inp.max_count < inp.min_count) push('error', 'maxBelowMin', 'max_count')
      }
      break
    }
    case 'scan': {
      if (!ENTITIES.includes(inp.entity)) push('error', 'entityInvalid', 'entity')
      const e = checkExpect(inp.expect)
      if (e === 'invalid') push('error', 'regexInvalid', 'expect')
      else if (e === 'unclosed') push('warning', 'regexUnclosed', 'expect')
      break
    }
    case 'signoff':
      if (inp.role != null && !ROLES.includes(inp.role)) push('error', 'invalidRole', 'role')
      break
  }
}

export function validateContent(content: RevisionContent, opts: ValidateOptions = {}): Issue[] {
  const out: Issue[] = []
  const steps = stepsOf(content)
  if (!steps.length) out.push({ severity: 'incomplete', key: 'noSteps' })

  const seen = new Set<Uuid>()
  const dup = (id: Uuid, at: Omit<Issue, 'severity' | 'key'>) => {
    if (seen.has(id)) out.push({ severity: 'error', key: 'duplicateId', params: { id }, ...at })
    seen.add(id)
  }
  const stepIds = new Set(steps.map((s) => s.id))
  const ws = opts.workstations ? new Set(opts.workstations) : null

  for (const sec of content.sections) {
    dup(sec.id, { sectionId: sec.id })
    if (blank(sec.title)) out.push({ severity: 'incomplete', key: 'sectionTitle', sectionId: sec.id, field: 'title' })
    if (!sec.steps.length) out.push({ severity: 'warning', key: 'emptySection', sectionId: sec.id })
    for (const st of sec.steps) {
      const at = { sectionId: sec.id, stepId: st.id }
      dup(st.id, at)
      if (blank(st.title)) out.push({ severity: 'incomplete', key: 'stepTitle', field: 'title', ...at })
      for (const d of st.depends_on) {
        if (d === st.id) out.push({ severity: 'error', key: 'selfDependency', field: 'depends_on', ...at })
        else if (!stepIds.has(d)) out.push({ severity: 'error', key: 'unknownDependency', field: 'depends_on', ...at })
      }
      if (ws) {
        for (const code of st.locations) {
          if (!ws.has(code)) out.push({ severity: 'warning', key: 'unknownLocation', field: 'locations', params: { code }, ...at })
        }
      }
      if (st.verification?.required && !ROLES.includes(st.verification.role)) {
        out.push({ severity: 'error', key: 'invalidRole', field: 'verification', ...at })
      }
      if (!st.inputs.length && !st.verification?.required) out.push({ severity: 'warning', key: 'noInputs', ...at })
      for (const inp of st.inputs) {
        dup(inp.id, { ...at, inputId: inp.id })
        validateInput(inp, { ...at, inputId: inp.id }, out)
      }
    }
  }

  if (findCycle(content)) {
    for (const id of cyclicSteps(content)) {
      const sec = content.sections.find((s) => s.steps.some((x) => x.id === id))
      out.push({ severity: 'error', key: 'cycle', field: 'depends_on', sectionId: sec?.id, stepId: id })
    }
  }
  return out
}

export const hasErrors = (issues: readonly Issue[]) => issues.some((i) => i.severity === 'error')
export const canSubmit = (issues: readonly Issue[]) => !issues.some((i) => i.severity === 'error' || i.severity === 'incomplete')
