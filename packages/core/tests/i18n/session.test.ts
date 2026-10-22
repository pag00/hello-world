import { describe, expect, it } from 'vitest'
import en from '../../src/i18n/en/session.json'
import de from '../../src/i18n/de/session.json'
import { VALIDATION_KEYS } from '../../src/domain/validation'

function keys(o: unknown, prefix = ''): string[] {
  if (!o || typeof o !== 'object') return [prefix]
  return Object.entries(o).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k)).sort()
}

describe('session i18n', () => {
  it('en and de have identical keys', () => {
    expect(keys(de)).toEqual(keys(en))
  })
  it('every validation key is translated', () => {
    for (const k of VALIDATION_KEYS) {
      expect(en.session.validation, k).toHaveProperty(k)
      expect(de.session.validation, k).toHaveProperty(k)
    }
  })
  it('every canEdit reason is translated', () => {
    for (const r of ['offline_not_checked_out', 'locked_by_other', 'not_locked', 'run_closed', 'checked_out_by_other']) {
      expect(en.session.editBlocked).toHaveProperty(r)
    }
  })
})
