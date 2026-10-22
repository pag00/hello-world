// Store/API failures → translated lines for the authoring, quality and admin screens.
import { ApiError, OfflineError } from '../../api/client'
import { ValidationError } from '../../domain/validation'

type T = (key: string, named?: Record<string, unknown>) => string

function detailOf(e: ApiError): string {
  const b = e.body as { detail?: unknown } | null
  if (!b || typeof b !== 'object') return typeof e.body === 'string' ? e.body : ''
  if (typeof b.detail === 'string') return b.detail
  // FastAPI 422: detail = [{loc, msg}, ...]
  if (Array.isArray(b.detail)) {
    return b.detail
      .map((d: { loc?: unknown[]; msg?: string }) => [Array.isArray(d.loc) ? d.loc.join('.') : '', d.msg ?? ''].filter(Boolean).join(': '))
      .join('; ')
  }
  return ''
}

export function errorText(e: unknown, t: T): string {
  if (e instanceof ValidationError) return e.keys.map((k) => t(k)).join(' ')
  if (e instanceof OfflineError) return t('st.authoring.errors.offline')
  if (e instanceof ApiError) {
    if (e.status === 401) return t('st.authoring.errors.unauthorized')
    if (e.status === 403) return t('st.authoring.errors.forbidden')
    if (e.status === 404) return t('st.authoring.errors.notFound')
    if (e.status === 409) return t('st.authoring.errors.conflict', { detail: detailOf(e) })
    if (e.status === 422) return t('st.authoring.errors.invalid', { detail: detailOf(e) })
    return t('st.authoring.errors.server', { status: e.status, detail: detailOf(e) })
  }
  if (e instanceof Error && /^st\.[\w.]+$/.test(e.message)) return t(e.message)
  return t('st.authoring.errors.unknown')
}
