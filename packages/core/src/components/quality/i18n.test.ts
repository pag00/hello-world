// Completeness of the authoring/quality translations: en and de have the same keys, every key the
// owned sources reference exists, every enum-driven family is complete, and every message compiles.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import enA from '../../i18n/en/authoring.json'
import deA from '../../i18n/de/authoring.json'
import enQ from '../../i18n/en/quality.json'
import deQ from '../../i18n/de/quality.json'
import type { EventFlag, EventType } from '../../domain/types'
import { ISSUE_KEYS, ROLES } from '../authoring/validation'
import { INPUT_TYPES } from '../authoring/contentOps'

type Tree = Record<string, unknown>

function leaves(o: unknown, prefix = ''): string[] {
  if (!o || typeof o !== 'object') return [prefix]
  return Object.entries(o as Tree).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k)).sort()
}

const en: Tree = { st: { ...enA, ...enQ } }
const de: Tree = { st: { ...deA, ...deQ } }

function has(tree: Tree, key: string): boolean {
  let cur: unknown = tree
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object' || !(part in (cur as Tree))) return false
    cur = (cur as Tree)[part]
  }
  return typeof cur === 'string'
}

const SRC = join(__dirname, '../..')
const OWNED = [
  'views/ProcedureListView.vue', 'views/ProcedureView.vue', 'views/RevisionEditView.vue', 'views/RunRecordView.vue',
  'views/TravellerView.vue', 'views/NcrListView.vue', 'views/NcrView.vue', 'views/ToolsView.vue', 'views/WorkstationsView.vue',
  'components/QrCode.vue',
]
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.(vue|ts)$/.test(f) && !f.endsWith('.test.ts') ? [p] : []
  })
}
const files = [...OWNED.map((f) => join(SRC, f)), ...walk(join(SRC, 'components/authoring')), ...walk(join(SRC, 'components/quality'))]

describe('authoring & quality i18n', () => {
  it('en and de have identical keys', () => {
    expect(leaves(deA)).toEqual(leaves(enA))
    expect(leaves(deQ)).toEqual(leaves(enQ))
  })

  it('every static key referenced in owned sources exists in en and de', () => {
    const missing: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/'(st\.[A-Za-z0-9_.]+)'/g)) {
        const key = m[1]!
        if (key.endsWith('.')) continue // prefix constant (ISSUE_PREFIX)
        // other workstreams' namespaces (st.common, st.session) are theirs to keep complete
        if (!/^st\.(authoring|quality)\./.test(key)) continue
        if (!has(en, key) || !has(de, key)) missing.push(`${key} (${f.slice(SRC.length)})`)
      }
    }
    expect(missing).toEqual([])
  })

  it('enum-driven families are complete', () => {
    const events: EventType[] = ['run.created', 'step.started', 'input.recorded', 'step.completed', 'step.verified', 'step.reopened',
      'note.added', 'ncr.raised', 'ncr.dispositioned', 'ncr.closed', 'conflict.resolved', 'run.completed', 'run.aborted']
    const flags: EventFlag[] = ['conflict', 'unlocked', 'late_lock', 'tool_expired', 'tool_unknown', 'blob_missing', 'out_of_tolerance']
    const families: Record<string, readonly string[]> = {
      'st.authoring.status': ['draft', 'in_review', 'released', 'obsolete'],
      'st.authoring.roles': ROLES,
      'st.authoring.severity': ['error', 'incomplete', 'warning'],
      'st.authoring.issues': ISSUE_KEYS,
      'st.authoring.input.types': INPUT_TYPES,
      'st.authoring.input.entities': ['part', 'tool', 'any'],
      'st.authoring.input': ['min', 'nominal', 'max'],
      'st.authoring.diff.fields': ['title', 'instructions', 'media', 'locations', 'depends_on', 'verification', 'section', 'order', 'inputs'],
      'st.authoring.diff.inputFields': ['type', 'label', 'required', 'multiline', 'unit', 'min', 'nominal', 'max', 'decimals', 'ocr', 'min_count', 'max_count', 'entity', 'expect', 'role', 'order'],
      'st.authoring.diff.kind': ['added', 'removed', 'changed'],
      'st.authoring.approvals': ['approve', 'reject'],
      'st.authoring.revision.dialog': ['submit', 'approve', 'reject', 'newRevision'].flatMap((k) => [`${k}Title`, `${k}Confirm`]),
      'st.quality.calibration': ['ok', 'due_soon', 'expired', 'not_required'],
      'st.quality.chain.problem': ['content_hash', 'unhashable', 'chain_hash', 'prev_link', 'duplicate_seq'],
      'st.quality.record.eventTypes': events.map((e) => e.replace('.', '_')),
      'st.quality.record.flags': flags,
      'st.quality.record.auth': ['oidc', 'pin'],
      'st.quality.record.sources': ['manual', 'ocr', 'scan'],
      'st.quality.record.detail': ['serial', 'workOrder', 'value', 'photos', 'source', 'ocrRaw', 'reason', 'note', 'lockTakeover', 'ncrRaised', 'ncrDispositioned', 'ncrClosed', 'conflictResolved'],
      'st.quality.ncr.status': ['open', 'dispositioned', 'closed'],
      'st.quality.ncr.filter': ['not_closed', 'open', 'dispositioned', 'closed', 'all'],
      'st.quality.ncr.dispositions': ['use_as_is', 'rework', 'repair', 'scrap', 'return_to_supplier'],
      'st.quality.tools.filter': ['all', 'expired', 'due_soon', 'ok', 'not_required', 'inactive'],
    }
    const missing: string[] = []
    for (const [prefix, keys] of Object.entries(families)) {
      for (const k of keys) {
        if (!has(en, `${prefix}.${k}`)) missing.push(`en ${prefix}.${k}`)
        if (!has(de, `${prefix}.${k}`)) missing.push(`de ${prefix}.${k}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('every message compiles and interpolates without warnings', () => {
    for (const [locale, tree] of [['en', en], ['de', de]] as const) {
      const warnings: string[] = []
      // untyped: the typed overloads blow up on a dynamic message tree (TS2589)
      type T = (key: string, named?: Record<string, unknown>, plural?: number) => string
      const i18n = (createI18n as unknown as (o: object) => { global: { t: T } })({
        legacy: false, locale, messages: { [locale]: tree } as never,
        missingWarn: false, fallbackWarn: false,
        warnHtmlMessage: false,
      })
      const t = i18n.global.t
      const origWarn = console.warn
      const origError = console.error
      console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(' '))
      console.error = (...a: unknown[]) => warnings.push(a.map(String).join(' '))
      try {
        for (const key of leaves(tree)) {
          const raw = key.split('.').reduce<unknown>((o, k) => (o as Tree)[k], tree) as string
          const names = [...new Set([...raw.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))]
          const params = Object.fromEntries(names.map((n) => [n, `<${n}>`]))
          const out = t(key, params, 2)
          expect(out, key).not.toBe(key)
          expect(out, key).not.toMatch(/[{}]/)
          for (const n of names) expect(out, key).toContain(`<${n}>`)
        }
        if (locale === 'en') {
          // plurals pick the right branch; regex examples survive the message compiler
          expect(t('st.quality.calibration.dueIn', { n: 1 }, 1)).toBe('Due in 1 day')
          expect(t('st.quality.calibration.dueIn', { n: 5 }, 5)).toBe('Due in 5 days')
          expect(t('st.authoring.input.expectHint')).toContain('/^PN-123-\\d+$/')
        }
      } finally {
        console.warn = origWarn
        console.error = origError
      }
      expect(warnings).toEqual([])
    }
  })
})
