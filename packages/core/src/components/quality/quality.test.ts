import { describe, expect, it } from 'vitest'
import { GENESIS_CHAIN_HASH, chainHash, eventContentHash, hashCanonical, sealEvent } from '../../domain/canonical'
import { parseQr } from '../../domain/qr'
import type { RevisionContent, RunEvent, RunEventContent } from '../../domain/types'
import { calibrationStatus, daysUntil, isValidDate, DUE_SOON_DAYS } from './calibration'
import { labelUrl } from './labels'
import { verifyLedger, verifyRevisionHash } from './recordVerify'
import { deadReasons, eventDetails, formatValue, scanRecords } from './timeline'

// local noon avoids any time-zone edge in the device-local calendar date
const day = (ymd: string) => new Date(`${ymd}T12:00:00`)

describe('calibration status', () => {
  it('not required when no due date', () => {
    expect(calibrationStatus({ calibration_due: null }, day('2026-10-22'))).toEqual({ status: 'not_required', days: null })
  })

  it('due date itself is still valid; expired the following day', () => {
    expect(calibrationStatus({ calibration_due: '2026-10-22' }, day('2026-10-22'))).toEqual({ status: 'due_soon', days: 0 })
    expect(calibrationStatus({ calibration_due: '2026-10-21' }, day('2026-10-22'))).toEqual({ status: 'expired', days: -1 })
  })

  it(`due within ${DUE_SOON_DAYS} days is due_soon, beyond is ok`, () => {
    expect(calibrationStatus({ calibration_due: '2026-11-21' }, day('2026-10-22')).status).toBe('due_soon') // 30 days
    expect(calibrationStatus({ calibration_due: '2026-11-22' }, day('2026-10-22')).status).toBe('ok') // 31 days
  })

  it('counts calendar days across month/year and DST boundaries', () => {
    expect(daysUntil('2027-01-01', day('2026-12-31'))).toBe(1)
    expect(daysUntil('2026-11-01', day('2026-10-24'))).toBe(8) // EU DST ends 2026-10-25
    expect(daysUntil('2028-03-01', day('2028-02-28'))).toBe(2) // leap year
  })

  it('malformed or impossible dates count as expired, never ok', () => {
    expect(calibrationStatus({ calibration_due: '2026-02-31' }, day('2026-01-01')).status).toBe('expired')
    expect(calibrationStatus({ calibration_due: 'soon' }, day('2026-01-01')).status).toBe('expired')
    expect(isValidDate('2026-02-28')).toBe(true)
    expect(isValidDate('2026-2-28')).toBe(false)
  })
})

describe('label URLs', () => {
  it('builds /q/<kind>/<id> under publicOrigin and basePath, and round-trips through the QR parser', () => {
    const cfg = { publicOrigin: 'https://st.example.org/', basePath: '/procedures-app/' }
    expect(labelUrl('tool', 'TW-017', cfg)).toBe('https://st.example.org/procedures-app/q/tool/TW-017')
    expect(labelUrl('ws', 'WS 03/A', cfg)).toBe('https://st.example.org/procedures-app/q/ws/WS%2003%2FA')
    const run = '0190f000-0000-7000-8000-0000000000aa'
    expect(labelUrl('run', run, cfg)).toBe(`https://st.example.org/procedures-app/q/run/${run}`)
    expect(parseQr(labelUrl('ws', 'WS 03/A', cfg))).toEqual({ kind: 'workstation', code: 'WS 03/A' })
    expect(parseQr(labelUrl('tool', 'TW-017', cfg))).toEqual({ kind: 'tool', code: 'TW-017' })
    expect(parseQr(labelUrl('run', run, cfg))).toEqual({ kind: 'run', run_id: run })
  })

  it('standalone basePath and window origin fallback', () => {
    expect(labelUrl('tool', 'T1', { basePath: '/' })).toBe(`${window.location.origin}/q/tool/T1`)
    expect(labelUrl('tool', 'T1', { basePath: '', publicOrigin: 'https://a.b' })).toBe('https://a.b/q/tool/T1')
  })
})

// ---------------------------------------------------------------------------

const RUN = '0190f000-0000-7000-8000-000000000001'
let n = 0
function content(over: Partial<RunEventContent> = {}): RunEventContent {
  n++
  return {
    id: `0190f000-0000-7000-8000-${String(n).padStart(12, '0')}`, run_id: RUN, type: 'note.added', step_id: null,
    payload: { text: `n${n}` }, actor_id: 'u', auth_method: 'oidc', device_id: 'd', client_ts: `2026-10-22T10:00:${String(n % 60).padStart(2, '0')}.000Z`,
    offline: false, supersedes: null, ...over,
  }
}

async function chain(contents: RunEventContent[]): Promise<RunEvent[]> {
  let prev = GENESIS_CHAIN_HASH
  const out: RunEvent[] = []
  for (const [i, c] of contents.entries()) {
    const sealed = await sealEvent(c)
    const ch = await chainHash(prev, sealed.content_hash)
    out.push({ ...sealed, seq: i + 1, prev_chain_hash: prev, chain_hash: ch, server_ts: c.client_ts, flags: [] })
    prev = ch
  }
  return out
}

describe('local ledger verification', () => {
  it('accepts an intact chain plus unsynced local events', async () => {
    const evs = await chain([content(), content(), content()])
    const local = await sealEvent(content())
    const r = await verifyLedger([...evs, local])
    expect(r).toMatchObject({ ok: true, total: 4, accepted: 3, local: 1, linked: 3, unchained: 0, missing_seqs: 0, problems: [] })
  })

  it('detects a tampered payload', async () => {
    const evs = await chain([content(), content()])
    evs[1] = { ...evs[1]!, payload: { text: 'edited' } }
    const r = await verifyLedger(evs)
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual([{ kind: 'content_hash', event_id: evs[1]!.id }])
  })

  it('detects an event swapped in with a recomputed content hash (chain breaks)', async () => {
    const evs = await chain([content(), content(), content()])
    const forged = await sealEvent({ ...content(), id: evs[1]!.id })
    evs[1] = { ...evs[1]!, ...forged }
    const r = await verifyLedger(evs)
    expect(r.problems.map((p) => p.kind)).toEqual(['chain_hash'])
  })

  it('detects a forged chain hash and a broken link', async () => {
    const evs = await chain([content(), content(), content()])
    const fake = 'sha256:' + 'f'.repeat(64)
    evs[1] = { ...evs[1]!, chain_hash: fake }
    // event 2's own hash no longer matches, and event 3 no longer links to event 2
    expect((await verifyLedger(evs)).problems.map((p) => p.kind).sort()).toEqual(['chain_hash', 'prev_link'])
    const first = await chain([content()])
    first[0] = { ...first[0]!, prev_chain_hash: fake, chain_hash: await chainHash(fake, first[0]!.content_hash) }
    expect((await verifyLedger(first)).problems.map((p) => p.kind)).toEqual(['prev_link']) // seq 1 must start at genesis
  })

  it('an incomplete local copy is information, not a problem', async () => {
    const evs = await chain([content(), content(), content(), content()])
    // seq 2 not pulled yet; seq 4 pushed by this device, chain data still pending
    const r = await verifyLedger([evs[0]!, evs[2]!, { ...evs[3]!, chain_hash: null, prev_chain_hash: null }])
    expect(r).toMatchObject({ ok: true, accepted: 3, linked: 1, unchained: 1, missing_seqs: 1, problems: [] })
  })

  it('duplicate seq is a problem', async () => {
    const evs = await chain([content(), content()])
    const dup = { ...evs[1]!, id: 'other', seq: 1 }
    const r = await verifyLedger([...evs, { ...dup, content_hash: await eventContentHash(dup) }])
    expect(r.problems.map((p) => p.kind)).toContain('duplicate_seq')
  })

  it('flags events that cannot be hashed (floats)', async () => {
    const e = { ...(await sealEvent(content())), payload: { text: 1.5 } } as unknown as RunEvent
    expect((await verifyLedger([e])).problems).toEqual([{ kind: 'unhashable', event_id: e.id }])
  })

  it('revision content hash', async () => {
    const c: RevisionContent = { schema: 1, sections: [] }
    expect(await verifyRevisionHash({ content: c, content_hash: await hashCanonical(c) })).toBe(true)
    expect(await verifyRevisionHash({ content: c, content_hash: 'sha256:' + '0'.repeat(64) })).toBe(false)
    expect(await verifyRevisionHash({ content: c, content_hash: null })).toBeNull()
  })
})

describe('timeline helpers', () => {
  const STEP = '0190f000-0000-7000-8000-00000000a001'
  const C: RevisionContent = {
    schema: 1,
    sections: [{ id: 's', title: 'S', steps: [{
      id: STEP, title: 'Torque', instructions: '', media: [], locations: [], depends_on: [],
      inputs: [
        { id: 'i-num', label: 'Torque', required: true, type: 'number', unit: 'Nm', decimals: 1, ocr: true, min: '1.0', max: '2.0' },
        { id: 'i-scan', label: 'Wrench', required: true, type: 'scan', entity: 'tool' },
      ],
    }] }],
  }

  it('dead reasons: superseded and rejected by conflict resolution', async () => {
    const a = await sealEvent(content({ type: 'input.recorded', step_id: STEP, payload: { input_id: 'i-num', value: '1.5', source: 'manual' } }))
    const b = await sealEvent(content({ type: 'input.recorded', step_id: STEP, payload: { input_id: 'i-num', value: '1.6', source: 'manual' }, supersedes: a.id }))
    const c = await sealEvent(content({ type: 'input.recorded', step_id: STEP, payload: { input_id: 'i-num', value: '1.7', source: 'manual' } }))
    const r = await sealEvent(content({ type: 'conflict.resolved', step_id: STEP, payload: { kept_event_ids: [b.id], rejected_event_ids: [c.id], reason: 'dup' } }))
    const dead = deadReasons([r, c, b, a] as RunEvent[])
    expect(dead.get(a.id)).toEqual({ kind: 'superseded', by: b.id })
    expect(dead.get(c.id)).toEqual({ kind: 'rejected', by: r.id })
    expect(dead.has(b.id)).toBe(false)
  })

  it('event details for values, OCR and NCRs', async () => {
    const e = await sealEvent(content({ type: 'input.recorded', step_id: STEP, payload: { input_id: 'i-num', value: '1.5', source: 'ocr', ocr_raw: '1.5 Nm' } }))
    expect(eventDetails(e as RunEvent, C, () => '')).toEqual([
      { key: 'value', params: { label: 'Torque', v: '1.5 Nm' } },
      { key: 'source', params: { v: 'ocr' } },
      { key: 'ocrRaw', params: { v: '1.5 Nm' } },
    ])
    const ncr = await sealEvent(content({ type: 'ncr.dispositioned', step_id: STEP, payload: { ncr_id: 'x', disposition: 'rework', note: 'redo' } }))
    expect(eventDetails(ncr as RunEvent, C, () => 'NCR-1')).toEqual([{ key: 'ncrDispositioned', params: { n: 'NCR-1', d: 'rework', v: 'redo' } }])
    expect(formatValue(null, ['sha256:a', 'sha256:b'])).toBe('2')
    expect(formatValue(null, true)).toBe('✓')
  })

  it('scan records list tool scans with dead state', async () => {
    const a = await sealEvent(content({ type: 'input.recorded', step_id: STEP, payload: { input_id: 'i-scan', value: 'TW-1', source: 'scan' } }))
    const b = await sealEvent(content({ type: 'input.recorded', step_id: STEP, payload: { input_id: 'i-scan', value: 'TW-2', source: 'scan' }, supersedes: a.id }))
    const recs = scanRecords(C, [a, b] as RunEvent[], new Set([a.id]))
    expect(recs.map((r) => [r.value, r.dead, r.input.entity])).toEqual([['TW-1', true, 'tool'], ['TW-2', false, 'tool']])
  })
})
