// Display formatting for record timestamps. Records keep UTC; the tablet shows local time with seconds,
// because "who did what when" is read off this screen during audits.
export function fmtDateTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function fmtTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}
