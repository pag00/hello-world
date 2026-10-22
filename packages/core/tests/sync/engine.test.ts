import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine, type PullSummary } from '../../src/sync/engine'
import { sealEvent, sha256Hex } from '../../src/domain/canonical'
import { uuidv7 } from '../../src/domain/uuid'
import type { RunEvent, RunEventContent } from '../../src/domain/types'
import type { StepTrackDB } from '../../src/db'
import { getDb } from '../../src/sync/runtime'
import { FakeServer, IDS, USERS, emptyPull, json, setup, teardown } from '../helpers'

const DEVICE = '0190f000-0000-7000-8000-000000000d01'
const RUN = '0190f000-0000-7000-8000-000000000a01'

let server: FakeServer
let db: StepTrackDB
let engine: SyncEngine
let userId: string | null
let pulled: PullSummary[]

beforeEach(async () => {
  ;({ server } = await setup({ seed: false }))
  db = getDb()
  userId = USERS.op!.id
  pulled = []
  engine = new SyncEngine({ db, deviceId: () => DEVICE, userId: () => userId, onPulled: (s) => void pulled.push(s) })
})

afterEach(async () => {
  engine.stop()
  await teardown()
})

async function queue(type: RunEvent['type'] = 'note.added', payload: object = { text: 'n' }, extra: Partial<RunEventContent> = {}): Promise<RunEvent> {
  const ev = await sealEvent({
    id: uuidv7(), run_id: RUN, type, step_id: null, payload: payload as never, actor_id: USERS.op!.id, auth_method: 'oidc',
    device_id: DEVICE, client_ts: new Date().toISOString(), offline: true, supersedes: null, ...extra,
  } as RunEventContent)
  await db.transaction('rw', db.events, db.outbox, async () => {
    await db.events.add(ev)
    await db.outbox.add({ event_id: ev.id, run_id: RUN, queued_at: ev.client_ts, attempts: 0, last_error: null })
  })
  return ev
}

describe('push', () => {
  it('accepted/duplicate store seq + flags and clear the outbox; payload carries no server fields', async () => {
    const a = await queue()
    const b = await queue()
    server.pushResult = (e) => (e.id === b.id ? { id: b.id, status: 'duplicate', seq: 7, flags: ['late_lock'] } : undefined)
    await engine.syncNow()

    expect(await db.outbox.count()).toBe(0)
    expect((await db.events.get(a.id))?.seq).toBe(1)
    expect(await db.events.get(b.id)).toMatchObject({ seq: 7, flags: ['late_lock'] })
    const body = server.callsTo('/sync/push')[0]!.body as { device_id: string; events: Record<string, unknown>[] }
    expect(body.device_id).toBe(DEVICE)
    expect(body.events.map((e) => e.id)).toEqual([a.id, b.id])
    expect(Object.keys(body.events[0]!)).not.toContain('seq')
    expect(body.events[0]!.content_hash).toBe(a.content_hash)
    expect(engine.pendingEvents.value).toBe(0)
    expect(engine.lastSyncAt.value).not.toBeNull()
  })

  it('rejected events move to the rejected table with the error — never dropped', async () => {
    const ok = await queue()
    const bad = await queue()
    server.pushResult = (e) => (e.id === bad.id ? { id: bad.id, status: 'rejected', error: 'actor lacks role' } : undefined)
    await engine.syncNow()

    expect(await db.outbox.count()).toBe(0)
    expect(await db.events.get(bad.id)).toBeUndefined()
    const rej = await db.rejected.get(bad.id)
    expect(rej).toMatchObject({ run_id: RUN, error: 'actor lacks role', acknowledged: 0 })
    expect(rej!.event).toEqual(bad)
    expect((await db.events.get(ok.id))?.seq).toBe(1)
    expect(engine.rejectedCount.value).toBe(1)
  })

  it('keeps events without a result in the outbox', async () => {
    const a = await queue()
    server.handlers.push((c) => (c.path === '/sync/push' ? json({ results: [] }) : undefined))
    await engine.syncNow()
    expect((await db.outbox.toArray()).map((r) => r.event_id)).toEqual([a.id])
    expect(await db.events.get(a.id)).toBeDefined()
  })

  it('pushes in batches of at most 500, in creation order', { timeout: 30_000 }, async () => {
    const evs = await Promise.all(Array.from({ length: 1203 }, () => sealEvent({
      id: uuidv7(), run_id: RUN, type: 'note.added', step_id: null, payload: { text: 'n' }, actor_id: USERS.op!.id, auth_method: 'oidc',
      device_id: DEVICE, client_ts: new Date().toISOString(), offline: true, supersedes: null,
    } as RunEventContent)))
    await db.transaction('rw', db.events, db.outbox, async () => {
      await db.events.bulkAdd(evs as RunEvent[])
      await db.outbox.bulkAdd(evs.map((e) => ({ event_id: e.id, run_id: RUN, queued_at: e.client_ts, attempts: 0, last_error: null })))
    })
    const ids = evs.map((e) => e.id)
    await engine.syncNow()
    const pushes = server.callsTo('/sync/push').map((c) => (c.body as { events: RunEvent[] }).events)
    expect(pushes.map((p) => p.length)).toEqual([500, 500, 203])
    expect(pushes.flat().map((e) => e.id)).toEqual(ids)
    expect(await db.outbox.count()).toBe(0)
  })

  it('bisects a batch-level 422 to isolate the offending event', async () => {
    const evs = [await queue(), await queue(), await queue(), await queue(), await queue()]
    const poison = evs[3]!.id
    server.handlers.push((c) => {
      if (c.path !== '/sync/push') return undefined
      const ids = (c.body as { events: RunEvent[] }).events.map((e) => e.id)
      return ids.includes(poison) ? json({ detail: 'float in payload' }, 422) : undefined
    })
    await engine.syncNow()
    expect(await db.outbox.count()).toBe(0)
    expect(await db.rejected.get(poison)).toMatchObject({ error: 'float in payload' })
    for (const e of evs.filter((x) => x.id !== poison)) expect((await db.events.get(e.id))?.seq).toBeGreaterThan(0)
  })

  it('a server error keeps everything queued and reports the error', async () => {
    const a = await queue()
    server.handlers.push((c) => (c.path === '/sync/push' ? json({ detail: 'db down' }, 503) : undefined))
    await engine.syncNow()
    expect((await db.outbox.toArray()).map((r) => r.event_id)).toEqual([a.id])
    expect(engine.lastError.value).toBe('db down')
    expect(engine.lastErrorCode.value).toBe('server')
    expect(engine.online.value).toBe(true)
  })

  it('401 is reported as an auth problem', async () => {
    await queue()
    server.handlers.push((c) => (c.path === '/sync/push' ? json({ detail: 'token expired' }, 401) : undefined))
    await engine.syncNow()
    expect(engine.lastErrorCode.value).toBe('auth')
    expect(await db.outbox.count()).toBe(1)
  })
})

describe('offline and gating', () => {
  it('is a no-op while offline: nothing pushed, nothing lost', async () => {
    const a = await queue()
    server.online = false
    await engine.syncNow()
    expect(engine.online.value).toBe(false)
    expect(server.callsTo('/sync/push')).toHaveLength(0)
    expect((await db.outbox.toArray()).map((r) => r.event_id)).toEqual([a.id])
    expect(engine.lastError.value).toBeNull()

    server.online = true
    await engine.syncNow()
    expect(await db.outbox.count()).toBe(0)
  })

  it('connection lost mid-sync flips to offline and keeps the outbox', async () => {
    await queue()
    server.handlers.push((c) => {
      if (c.path === '/sync/push') throw new TypeError('network down')
      return undefined
    })
    await engine.syncNow()
    expect(engine.online.value).toBe(false)
    expect(await db.outbox.count()).toBe(1)
  })

  it('does not sync while nobody is signed in', async () => {
    await queue()
    userId = null
    await engine.syncNow()
    expect(server.calls).toHaveLength(0)
  })

  it('concurrent syncNow calls share one cycle and schedule one rerun', async () => {
    await queue()
    await Promise.all([engine.syncNow(), engine.syncNow(), engine.syncNow()])
    // first cycle + exactly one rerun (pull runs once per cycle)
    expect(server.callsTo('/sync/pull')).toHaveLength(2)
  })

  it('probe treats 5xx as unreachable and 4xx as reachable', async () => {
    server.handlers.push((c) => (c.path === '/health' ? json({}, 502) : undefined))
    expect(await engine.probe()).toBe(false)
    server.handlers = [(c) => (c.path === '/health' ? json({}, 404) : undefined)]
    expect(await engine.probe()).toBe(true)
  })
})

describe('blobs', () => {
  async function putBlob(bytes: Uint8Array, mime = 'image/jpeg') {
    const hex = await sha256Hex(bytes)
    await db.blobs.put({ sha256: hex, data: bytes.buffer.slice(0) as ArrayBuffer, mime, size: bytes.length, uploaded: 0, created_at: new Date().toISOString() })
    return hex
  }

  it('uploads referenced blobs (HEAD then PUT) before pushing events', async () => {
    const hex = await putBlob(new Uint8Array([1, 2, 3, 4]))
    await queue('input.recorded', { input_id: IDS.B_PHOTO, value: [`sha256:${hex}`], source: 'manual' }, { step_id: IDS.B })
    await engine.syncNow()
    const order = server.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`).filter((s) => !s.includes('/health') && !s.includes('/sync/pull'))
    expect(order).toEqual([`HEAD /blobs/${hex}`, `PUT /blobs/${hex}`, 'POST /sync/push'])
    expect(server.calls.find((c) => c.method === 'PUT')!.headers.get('content-type')).toBe('image/jpeg')
    expect(Array.from(server.blobs.get(hex)!)).toEqual([1, 2, 3, 4])
    expect((await db.blobs.get(hex))?.uploaded).toBe(1)
    expect(engine.pendingBlobs.value).toBe(0)
  })

  it('skips the PUT when the server already has the blob', async () => {
    const hex = await putBlob(new Uint8Array([9, 9]))
    server.blobs.set(hex, new Uint8Array([9, 9]))
    await engine.syncNow()
    expect(server.callsTo(`/blobs/${hex}`, 'PUT')).toHaveLength(0)
    expect((await db.blobs.get(hex))?.uploaded).toBe(1)
  })

  it('a refused blob does not block event push', async () => {
    const hex = await putBlob(new Uint8Array([5]))
    await queue()
    server.handlers.push((c) => (c.method === 'PUT' ? json({ detail: 'hash mismatch' }, 400) : undefined))
    await engine.syncNow()
    expect(await db.outbox.count()).toBe(0)
    expect(await db.blobs.get(hex)).toMatchObject({ uploaded: 0, last_error: 'hash mismatch' })
  })
})

describe('pull', () => {
  it('follows has_more, persists the cursor, notifies once', async () => {
    const ev = (await sealEvent({ id: uuidv7(), run_id: RUN, type: 'note.added', step_id: null, payload: { text: 'srv' }, actor_id: USERS.sup!.id,
      auth_method: 'oidc', device_id: 'other', client_ts: '2026-10-22T10:00:00.000Z', offline: false, supersedes: null })) as RunEvent
    server.pullPages = [
      emptyPull('1', { has_more: true, users: [USERS.sup!], tools: [{ id: 't', code: 'TW-1', description: '', calibration_due: null, active: true }] }),
      emptyPull('2', { has_more: true, events: [{ ...ev, seq: 1, flags: ['unlocked'] }] }),
      emptyPull('3', { has_more: false, workstations: [{ code: 'WS-01', name: 'Bench' }] }),
    ]
    await engine.syncNow()
    const cursors = server.callsTo('/sync/pull').map((c) => new URLSearchParams(c.path.split('?')[1]).get('cursor'))
    expect(cursors).toEqual([null, '1', '2'])
    expect(await db.getMeta(`cursor:${USERS.op!.id}`)).toBe('3')
    expect(await db.events.get(ev.id)).toMatchObject({ seq: 1, flags: ['unlocked'] })
    expect(await db.users.get(USERS.sup!.id)).toBeDefined()
    expect(await db.workstations.get('WS-01')).toBeDefined()
    expect(pulled).toHaveLength(1)
    expect([...pulled[0]!.eventRunIds]).toEqual([RUN])

    // next sync resumes from the stored cursor
    server.calls = []
    await engine.syncNow()
    expect(new URLSearchParams(server.callsTo('/sync/pull')[0]!.path.split('?')[1]).get('cursor')).toBe('3')
  })

  it('stops when the server repeats the cursor despite has_more', async () => {
    server.handlers.push((c) => (c.path.startsWith('/sync/pull') ? json(emptyPull('same', { has_more: true })) : undefined))
    await engine.syncNow()
    expect(server.callsTo('/sync/pull').length).toBeLessThanOrEqual(2)
  })

  it('server version wins; a diverging local copy is kept as rejected evidence', async () => {
    const local = await queue()
    const same = await queue()
    // simulate a push whose response was lost: hold the push, deliver via pull first
    server.handlers.push((c) => (c.path === '/sync/push' ? json({ results: [] }) : undefined))
    server.pullPages = [emptyPull('1', { events: [
      { ...local, payload: { text: 'different' }, content_hash: 'sha256:' + 'f'.repeat(64), seq: 4 },
      { ...same, seq: 5, chain_hash: 'sha256:' + 'c'.repeat(64), flags: [] },
    ] })]
    await engine.syncNow()
    expect(await db.events.get(local.id)).toMatchObject({ seq: 4, payload: { text: 'different' } })
    expect(await db.rejected.get(local.id)).toMatchObject({ error: 'server_version_differs', event: local })
    expect(await db.events.get(same.id)).toMatchObject({ seq: 5, content_hash: same.content_hash })
    expect((await db.outbox.toArray()).map((r) => r.event_id)).toEqual([same.id])
  })
})

describe('locks & checkout', () => {
  it('heartbeat renews own locks and forgets ones the server dropped', async () => {
    const exp = new Date(Date.now() + 10_000).toISOString()
    await db.locks.bulkPut([
      { lock_id: 'mine', run_id: RUN, step_id: IDS.A, holder_user: USERS.op!.id, holder_device: DEVICE, expires_at: exp },
      { lock_id: 'gone', run_id: RUN, step_id: IDS.B, holder_user: USERS.op!.id, holder_device: DEVICE, expires_at: exp },
      { lock_id: 'foreign-old', run_id: RUN, step_id: IDS.C, holder_user: 'x', holder_device: 'other', expires_at: '2000-01-01T00:00:00.000Z' },
    ])
    server.locks.set('mine', { lock_id: 'mine', run_id: RUN, step_id: IDS.A, holder_user: USERS.op!.id, holder_device: DEVICE, expires_at: exp })
    await engine.heartbeat()
    expect(server.callsTo('/locks/mine/heartbeat')).toHaveLength(1)
    expect((await db.locks.get('mine'))!.expires_at > exp).toBe(true)
    expect(await db.locks.get('gone')).toBeUndefined()
    expect(await db.locks.get('foreign-old')).toBeUndefined()
  })

  it('checkout release waits until the run has nothing left to push', async () => {
    await db.checkouts.put({ run_id: RUN, holder_user: USERS.op!.id, holder_device: DEVICE, expires_at: new Date(Date.now() + 3600_000).toISOString() })
    await queue()
    let failPush = true
    server.handlers.push((c) => (c.path === '/sync/push' && failPush ? json({ detail: 'busy' }, 503) : undefined))

    expect(await engine.requestCheckoutRelease(RUN)).toBe(false)
    expect(server.callsTo(`/runs/${RUN}/checkout`, 'DELETE')).toHaveLength(0)
    expect((await db.checkouts.get(RUN))?.release_requested).toBe(true)

    failPush = false
    await engine.syncNow()
    const calls = server.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)
    expect(calls.indexOf(`DELETE /runs/${RUN}/checkout`)).toBeGreaterThan(calls.lastIndexOf('POST /sync/push'))
    expect(await db.checkouts.get(RUN)).toBeUndefined()
  })

  it('implicit checkout for offline-created runs uses the default 12 h from client_ts', () => {
    const row = engine.implicitCheckoutRow(RUN, USERS.op!.id, '2026-10-22T10:00:00.000Z')
    expect(row).toMatchObject({ run_id: RUN, holder_device: DEVICE, expires_at: '2026-10-22T22:00:00.000Z', implicit: true })
  })
})

describe('scheduling', () => {
  it('debounces syncs after local writes', async () => {
    vi.useFakeTimers()
    try {
      const e = new SyncEngine({ db, deviceId: () => DEVICE, userId: () => userId, debounceMs: 1000 })
      const spy = vi.spyOn(e, 'syncNow').mockResolvedValue()
      e.schedule()
      e.schedule()
      e.schedule()
      await vi.advanceTimersByTimeAsync(999)
      expect(spy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
