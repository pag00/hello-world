import { describe, expect, it } from 'vitest'
import { buildQrText, buildQrUrl, parseQr, qrTargetFromRoute } from '../../src/domain/qr'
import type { QrTarget } from '../../src/domain/types'

const RUN = '0190f1a2-b3c4-7d5e-8f60-123456789abc'

describe('qr', () => {
  it('parses URL form under any basePath', () => {
    expect(parseQr('https://mes.example.org/q/ws/WS-03')).toEqual({ kind: 'workstation', code: 'WS-03' })
    expect(parseQr('https://mes.example.org/apps/procedures/q/ws/WS-03')).toEqual({ kind: 'workstation', code: 'WS-03' })
    expect(parseQr('https://h/a/q/b/q/tool/TW-017?x=1#frag')).toEqual({ kind: 'tool', code: 'TW-017' })
    expect(parseQr(`https://h/st/q/run/${RUN.toUpperCase()}`)).toEqual({ kind: 'run', run_id: RUN })
    expect(parseQr('https://h/q/part/PN-123%2FA/SN%20001')).toEqual({ kind: 'part', part_number: 'PN-123/A', serial: 'SN 001' })
    expect(parseQr('/procedures/q/ws/WS-01/')).toEqual({ kind: 'workstation', code: 'WS-01' })
  })

  it('parses st: form', () => {
    expect(parseQr('st:ws:WS-03')).toEqual({ kind: 'workstation', code: 'WS-03' })
    expect(parseQr('ST:WS:WS-03')).toEqual({ kind: 'workstation', code: 'WS-03' })
    expect(parseQr(` st:run:${RUN}\n`)).toEqual({ kind: 'run', run_id: RUN })
    expect(parseQr('st:part:PN-1:SN-9')).toEqual({ kind: 'part', part_number: 'PN-1', serial: 'SN-9' })
    expect(parseQr('st:tool:TW-017')).toEqual({ kind: 'tool', code: 'TW-017' })
  })

  it('returns unknown for anything else', () => {
    for (const raw of ['', 'hello', 'st:ws:', 'st:run:not-a-uuid', 'st:part:only', 'st:part:a:b:c', 'https://h/q/foo/bar',
      'https://h/q/ws/', 'st:nope:x', 'https://h/q/part/onlyone', 'http://[bad']) {
      expect(parseQr(raw), raw).toEqual({ kind: 'unknown', raw })
    }
  })

  it('round-trips build → parse', () => {
    const targets: Exclude<QrTarget, { kind: 'unknown' }>[] = [
      { kind: 'workstation', code: 'WS-03' },
      { kind: 'tool', code: 'TW/017 ä' },
      { kind: 'run', run_id: RUN },
      { kind: 'part', part_number: 'PN:12/3%', serial: 'S N:1' },
    ]
    for (const t of targets) {
      expect(parseQr(buildQrText(t))).toEqual(t)
      expect(parseQr(buildQrUrl(t, 'https://mes.example.org/', '/apps/st/'))).toEqual(t)
      expect(parseQr(buildQrUrl(t, 'https://mes.example.org', ''))).toEqual(t)
    }
    expect(buildQrUrl({ kind: 'workstation', code: 'WS-03' }, 'https://h', '/procedures')).toBe('https://h/procedures/q/ws/WS-03')
    expect(buildQrText({ kind: 'part', part_number: 'A:B', serial: '1' })).toBe('st:part:A%3AB:1')
  })

  it('maps st-qr route params', () => {
    expect(qrTargetFromRoute('ws', ['WS-03'])).toEqual({ kind: 'workstation', code: 'WS-03' })
    expect(qrTargetFromRoute('part', ['PN 1', 'SN-2'])).toEqual({ kind: 'part', part_number: 'PN 1', serial: 'SN-2' })
    expect(qrTargetFromRoute('run', RUN)).toEqual({ kind: 'run', run_id: RUN })
    expect(qrTargetFromRoute('zzz', ['x']).kind).toBe('unknown')
  })
})
