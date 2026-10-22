// `expect` on a scan input is either an exact value or "/regex/flags" (ARCHITECTURE §3.2). The scan UI
// uses it only as a hint: the run components enforce it before anything is recorded.
import { matchesExpect } from '../domain/validation'

export type ExpectHint = { kind: 'none' } | { kind: 'exact'; value: string } | { kind: 'pattern'; pattern: string; valid: boolean }

const REGEX_FORM = /^\/(.*)\/([a-z]*)$/s

export function describeExpect(expect: string | null | undefined): ExpectHint {
  if (expect == null || expect === '') return { kind: 'none' }
  const m = REGEX_FORM.exec(expect)
  if (!m) return { kind: 'exact', value: expect }
  let valid = true
  try {
    new RegExp(m[1]!, m[2]!.replace(/[gy]/g, ''))
  } catch {
    valid = false
  }
  return { kind: 'pattern', pattern: expect, valid }
}

export type ExpectCheck = 'none' | 'match' | 'mismatch'

/** Same rule the run components enforce (trimmed text, matchesExpect), so the hint never disagrees with them. */
export function checkExpect(text: string, expect: string | null | undefined): ExpectCheck {
  if (describeExpect(expect).kind === 'none') return 'none'
  return matchesExpect(text.trim(), expect) ? 'match' : 'mismatch'
}
