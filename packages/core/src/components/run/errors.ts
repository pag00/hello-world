// Turn whatever a store action threw into translated, operator-readable lines.
import { ApiError, OfflineError } from '../../api/client'
import { ValidationError } from '../../domain/validation'
import { PendingSyncError } from '../../sync/engine'

type T = (key: string, named?: Record<string, unknown>) => string

export function errorLines(e: unknown, t: T): string[] {
  if (e instanceof ValidationError) return e.keys.map((k) => t(k))
  if (e instanceof OfflineError) return [t('st.run.errors.offline')]
  if (e instanceof PendingSyncError) return [t('st.run.checkout.releasePending')]
  if (e instanceof ApiError) {
    if (e.status === 409) return [t('st.run.errors.conflict409')]
    if (e.status === 403) return [t('st.run.errors.forbidden')]
    const b = e.body as { detail?: unknown } | null
    const detail = b && typeof b === 'object' && typeof b.detail === 'string' ? b.detail : null
    return [t('st.run.errors.server', { status: e.status, detail: detail ?? '' })]
  }
  // stores throw Error('st.…') for translatable states (e.g. not signed in)
  if (e instanceof Error && /^st\.[\w.]+$/.test(e.message)) return [t(e.message)]
  return [t('st.run.errors.unknown')]
}

/** Device components emit either an i18n key or an already translated message. */
export function deviceErrorText(m: string, t: T): string {
  return /^st\.[\w.]+$/.test(m) ? t(m) : m || t('st.run.errors.device')
}
