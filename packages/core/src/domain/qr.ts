// QR payloads — ARCHITECTURE §9. Labels are printed once and outlive deployments, so the parser
// accepts the URL form under any host/basePath and the compact st: form, case-insensitively for the prefix.

import type { QrTarget } from './types'
import { isUuid } from './uuid'

type Kind = 'ws' | 'run' | 'part' | 'tool'
const KINDS: readonly Kind[] = ['ws', 'run', 'part', 'tool']

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

function fromParts(kind: string, parts: string[], raw: string): QrTarget {
  const unknown: QrTarget = { kind: 'unknown', raw }
  const k = kind.toLowerCase() as Kind
  if (!KINDS.includes(k)) return unknown
  const decoded = parts.map(decode)
  if (decoded.some((p) => p === null || p.trim() === '')) return unknown
  const d = decoded as string[]
  switch (k) {
    case 'ws':
      return d.length === 1 ? { kind: 'workstation', code: d[0]! } : unknown
    case 'tool':
      return d.length === 1 ? { kind: 'tool', code: d[0]! } : unknown
    case 'run':
      return d.length === 1 && isUuid(d[0]) ? { kind: 'run', run_id: d[0]!.toLowerCase() } : unknown
    case 'part':
      return d.length === 2 ? { kind: 'part', part_number: d[0]!, serial: d[1]! } : unknown
  }
}

/** Route params of the st-qr route ('q/:kind/:rest(.*)*') → target. */
export function qrTargetFromRoute(kind: string, rest: string | string[], raw?: string): QrTarget {
  const parts = (Array.isArray(rest) ? rest : rest.split('/')).filter((p) => p !== '')
  // vue-router already decoded the params; re-encode so fromParts' decode is a no-op on plain text
  return fromParts(kind, parts.map(encodeURIComponent), raw ?? `/q/${kind}/${parts.join('/')}`)
}

export function parseQr(text: string): QrTarget {
  const raw = text
  const s = text.trim()
  if (!s) return { kind: 'unknown', raw }

  if (/^st:/i.test(s)) {
    const [, kind = '', ...parts] = s.split(':')
    return fromParts(kind, parts, raw)
  }

  // URL form (absolute or bare path). Take the last "/q/<kind>/" so any basePath works,
  // including basePaths that themselves contain a "q" segment.
  let path = s
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      path = new URL(s).pathname
    } catch {
      return { kind: 'unknown', raw }
    }
  } else {
    path = s.split(/[?#]/)[0]!
  }
  const re = /\/q\/(ws|run|part|tool)\/(.+)$/i
  let match: RegExpExecArray | null = null
  for (let i = path.lastIndexOf('/q/'); i >= 0; i = path.lastIndexOf('/q/', i - 1)) {
    match = re.exec(path.slice(i))
    if (match || i === 0) break
  }
  if (!match) return { kind: 'unknown', raw }
  const parts = match[2]!.replace(/\/+$/, '').split('/')
  return fromParts(match[1]!, parts, raw)
}

function targetParts(t: Exclude<QrTarget, { kind: 'unknown' }>): [Kind, string[]] {
  switch (t.kind) {
    case 'workstation':
      return ['ws', [t.code]]
    case 'tool':
      return ['tool', [t.code]]
    case 'run':
      return ['run', [t.run_id]]
    case 'part':
      return ['part', [t.part_number, t.serial]]
  }
}

/** "https://host/<basePath>/q/ws/WS-03" */
export function buildQrUrl(target: Exclude<QrTarget, { kind: 'unknown' }>, origin: string, basePath = '/'): string {
  const [kind, parts] = targetParts(target)
  const base = ('/' + basePath).replace(/\/+/g, '/').replace(/\/$/, '')
  return `${origin.replace(/\/+$/, '')}${base}/q/${kind}/${parts.map(encodeURIComponent).join('/')}`
}

/** "st:ws:WS-03" — ':' and '%' inside values are percent-encoded so the split stays unambiguous. */
export function buildQrText(target: Exclude<QrTarget, { kind: 'unknown' }>): string {
  const [kind, parts] = targetParts(target)
  return `st:${kind}:${parts.map((p) => p.replace(/%/g, '%25').replace(/:/g, '%3A')).join(':')}`
}
