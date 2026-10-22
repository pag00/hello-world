import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '../../../i18n/en/run.json'
import de from '../../../i18n/de/run.json'

function keys(o: unknown, prefix = ''): string[] {
  if (!o || typeof o !== 'object') return [prefix]
  return Object.entries(o).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k)).sort()
}

function has(obj: unknown, path: string): boolean {
  let cur: unknown = obj
  for (const p of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !(p in cur)) return false
    cur = (cur as Record<string, unknown>)[p]
  }
  return typeof cur === 'string'
}

const SRC = join(__dirname, '../../..')
const OWNED = [
  ...['HomeView', 'RunListView', 'RunStartView', 'RunView', 'RunStepView', 'QrResolveView'].map((v) => join(SRC, 'views', `${v}.vue`)),
  ...walk(join(SRC, 'components/run')).filter((f) => !f.includes('__tests__')),
]
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.(vue|ts)$/.test(f) ? [p] : []
  })
}

// dynamic key families: `st.run.<family>.${x}` → every value x can take
const FAMILIES: Record<string, string[]> = {
  'status': ['active', 'blocked', 'completed', 'aborted'],
  'stepState': ['pending', 'in_progress', 'blocked', 'completed', 'verified', 'conflict'],
  'block': ['depends_on', 'out_of_tolerance', 'tool_expired', 'tool_unknown', 'open_ncr'],
  'readOnly': ['offline_not_checked_out', 'locked_by_other', 'not_locked', 'run_closed', 'checked_out_by_other'],
  'flag': ['conflict', 'unlocked', 'late_lock', 'tool_expired', 'tool_unknown', 'blob_missing', 'out_of_tolerance'],
  'source': ['manual', 'ocr', 'scan'],
  'tool': ['ok', 'expired', 'unknown', 'inactive'],
  'scan.toolBlocked': ['expired', 'unknown', 'inactive'],
  'number.state': ['in', 'low', 'high', 'invalid', 'too_many_decimals'],
  'number.recorded': ['low', 'high', 'invalid'],
  'ncr.status': ['open', 'dispositioned', 'closed'],
  'list.filters': ['open', 'active', 'blocked', 'completed', 'aborted', 'all'],
  'eventType': ['run_created', 'step_started', 'input_recorded', 'step_completed', 'step_verified', 'step_reopened', 'note_added',
    'ncr_raised', 'ncr_dispositioned', 'ncr_closed', 'conflict_resolved', 'run_completed', 'run_aborted'],
}

describe('run i18n', () => {
  it('en and de have identical keys', () => {
    expect(keys(de)).toEqual(keys(en))
  })

  it('no message is empty', () => {
    for (const k of keys(en)) expect(has(en, k), k).toBe(true)
    for (const k of keys(de)) expect((k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], de) as string).trim(), k).not.toBe('')
  })

  it('every key used by the execution UI exists', () => {
    const used = new Set<string>()
    const dynamic = new Set<string>()
    for (const f of OWNED) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/['"`]st\.run\.([A-Za-z0-9_.]+?)(\$\{|['"`])/g)) {
        if (m[2] === '${') dynamic.add(m[1]!.replace(/\.$/, ''))
        else used.add(m[1]!)
      }
    }
    expect(used.size).toBeGreaterThan(100)
    for (const k of used) expect(has(en, `run.${k}`), `st.run.${k}`).toBe(true)
    for (const fam of dynamic) {
      expect(FAMILIES, `dynamic family st.run.${fam}.*`).toHaveProperty([fam])
      for (const v of FAMILIES[fam]!) expect(has(en, `run.${fam}.${v}`), `st.run.${fam}.${v}`).toBe(true)
    }
  })
})
