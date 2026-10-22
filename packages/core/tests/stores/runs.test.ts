import { pbkdf2Sync, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRunsStore, useSessionStore, useSyncStore, useRegistryStore } from '../../src/stores'
import { eventContentHash } from '../../src/domain/canonical'
import { V, ValidationError } from '../../src/domain/validation'
import { OfflineError } from '../../src/api/client'
import { getDb, syncState } from '../../src/sync/runtime'
import { IDS, REVISION, USERS, json, setup, teardown } from '../helpers'

afterEach(teardown)

async function boot(opts: Parameters<typeof setup>[0] = {}) {
  const env = await setup(opts)
  const session = useSessionStore()
  await session.init()
  const sync = useSyncStore()
  await sync.syncNow()
  return { ...env, session, runs: useRunsStore(), sync, registry: useRegistryStore() }
}

describe('runs store: event creation', () => {
  it('writes event + outbox atomically with a correct content hash', async () => {
    const { runs, session } = await boot()
    const run = await runs.startRun({ revisionId: REVISION.id, serial: ' SN-001 ', workOrder: '' })
    expect(run.serial).toBe('SN-001')
    expect(run.work_order).toBeNull()
    const ev = await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, value: '12', source: 'manual' })

    expect(ev.payload).toEqual({ input_id: IDS.A_TORQUE, value: '12.0', source: 'manual' })
    expect(ev.actor_id).toBe(USERS.op!.id)
    expect(ev.device_id).toBe(session.deviceId)
    expect(ev.offline).toBe(false)
    expect(ev.client_ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(ev.content_hash).toBe(await eventContentHash(ev))

    const db = getDb()
    const stored = await db.events.get(ev.id)
    expect(stored?.content_hash).toBe(ev.content_hash)
    const outbox = await db.outbox.orderBy('oid').toArray()
    expect(outbox.map((o) => o.event_id)).toEqual([runs.events(run.id)[0]!.id, ev.id])
    expect(runs.events(run.id).map((e) => e.type)).toEqual(['run.created', 'input.recorded'])
    expect(runs.projection(run.id).value?.steps[IDS.A]?.state).toBe('in_progress')
  })

  it('rolls back the event when the outbox write fails', async () => {
    const { runs } = await boot()
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-2' })
    const db = getDb()
    const before = await db.events.count()
    const spy = vi.spyOn(db.outbox, 'add').mockImplementationOnce(() => Promise.reject(new Error('disk full')) as never)
    await expect(runs.startStep(run.id, IDS.A)).rejects.toThrow('disk full')
    spy.mockRestore()
    expect(await db.events.count()).toBe(before)
    expect(await db.outbox.count()).toBe(before)
    expect(runs.events(run.id)).toHaveLength(1)
    // and the store keeps working afterwards
    await runs.startStep(run.id, IDS.A)
    expect(await db.outbox.count()).toBe(before + 1)
  })

  it('throws ValidationError with i18n keys and writes nothing', async () => {
    const { runs } = await boot()
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-3' })
    await expect(runs.completeStep(run.id, IDS.A)).rejects.toMatchObject({ keys: [V + 'missingRequired'] })
    await expect(runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, value: '12.34', source: 'ocr' }))
      .rejects.toMatchObject({ keys: [V + 'tooManyDecimals'] })
    await expect(runs.reopenStep(run.id, IDS.A, 'x')).rejects.toBeInstanceOf(ValidationError)
    expect(await getDb().events.count()).toBe(1)
    expect(runs.validateComplete(run.id, IDS.A)).toEqual([V + 'missingRequired'])
  })

  it('serializes concurrent writes so a double tap cannot complete twice', async () => {
    const { runs } = await boot()
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-4' })
    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_CHECK, value: true, source: 'manual' })
    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, value: '12.1', source: 'manual' })
    const results = await Promise.allSettled([runs.completeStep(run.id, IDS.A), runs.completeStep(run.id, IDS.A)])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(runs.events(run.id).filter((e) => e.type === 'step.completed')).toHaveLength(1)
  })

  it('records offline: offline flag, implicit checkout, local NCR row, run status cache', async () => {
    const { runs, server } = await boot()
    server.online = false
    syncState.online.value = false
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-OFF' })
    const created = runs.events(run.id)[0]!
    expect(created.offline).toBe(true)
    const co = runs.checkoutOf(run.id)
    expect(co?.holder_device).toBe(useSessionStore().deviceId)
    expect(Date.parse(co!.expires_at) - Date.parse(created.client_ts)).toBe(12 * 3600_000)
    expect(runs.canEdit(run.id, IDS.A)).toEqual({ ok: true })

    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, value: '13,0', source: 'manual' })
    expect(runs.getRun(run.id)?.status).toBe('blocked')
    await runs.raiseNcr({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, description: 'over torque' })
    const ncr = (await getDb().ncrs.toArray())[0]!
    expect(ncr).toMatchObject({ run_id: run.id, step_id: IDS.A, input_id: IDS.A_TORQUE, status: 'open', number: null })
    expect(useRegistryStore().ncrs.map((n) => n.id)).toContain(ncr.id)
    expect(runs.getRun(run.id)?.status).toBe('active')
    expect((await getDb().runs.get(run.id))?.status).toBe('active')
  })

  it('authoring/admin actions refuse offline', async () => {
    const { runs, registry } = await boot()
    syncState.online.value = false
    await expect(registry.upsertWorkstation({ code: 'WS-9', name: 'x' })).rejects.toBeInstanceOf(OfflineError)
    await expect(runs.lockStep('r', IDS.A)).rejects.toBeInstanceOf(OfflineError)
  })

  it('signs with a PIN verified locally; verifier ≠ completer enforced', async () => {
    const { runs, session } = await boot()
    const salt = randomBytes(16)
    const hash = pbkdf2Sync('246810', salt, 210000, 32, 'sha256')
    const insp = { ...USERS.insp!, pin_verifier: `pbkdf2-sha256$210000$${salt.toString('base64')}$${hash.toString('base64')}` }
    await getDb().users.put(insp)
    await getDb().tools.put({ id: 't1', code: 'TW-017', description: 'Torque wrench', calibration_due: '2999-01-01', active: true })
    await useRegistryStore().hydrate()

    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-5' })
    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_CHECK, value: true, source: 'manual' })
    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, value: '12.0', source: 'manual' })
    await runs.completeStep(run.id, IDS.A)
    await runs.recordInput({ runId: run.id, stepId: IDS.B, inputId: IDS.B_PHOTO, value: ['sha256:' + 'cd'.repeat(32)], source: 'manual' })
    await runs.recordInput({ runId: run.id, stepId: IDS.B, inputId: IDS.B_TOOL, value: ' TW-017 ', source: 'scan' })
    expect(runs.projection(run.id).value?.steps[IDS.B]?.inputs[IDS.B_TOOL]?.value).toBe('TW-017')
    await runs.completeStep(run.id, IDS.B)

    expect(await session.verifyPin(insp.id, '000000')).toBeNull()
    const signer = await session.verifyPin(insp.id, '246810')
    expect(signer).toMatchObject({ auth_method: 'pin', user: { id: insp.id } })
    expect(session.pinSigners.map((u) => u.id)).toEqual([insp.id])
    const v = await runs.verifyStep(run.id, IDS.B, signer!)
    expect(v).toMatchObject({ actor_id: insp.id, auth_method: 'pin' })
    expect(runs.projection(run.id).value?.steps[IDS.B]?.state).toBe('verified')
  })

  it('locks out PIN entry after repeated failures', async () => {
    const { session } = await boot()
    const salt = randomBytes(16)
    const hash = pbkdf2Sync('135790', salt, 100000, 32, 'sha256')
    await getDb().users.put({ ...USERS.insp!, pin_verifier: `pbkdf2-sha256$100000$${salt.toString('base64')}$${hash.toString('base64')}` })
    await useRegistryStore().hydrate()
    for (let i = 0; i < 5; i++) expect(await session.verifyPin(USERS.insp!.id, '111111')).toBeNull()
    expect(session.pinLockedUntil(USERS.insp!.id)).toBeGreaterThan(Date.now())
    expect(await session.verifyPin(USERS.insp!.id, '135790')).toBeNull()
  })
})

describe('tool calibration (§3.2)', () => {
  it('checkTool uses the local calendar date; due date itself is valid', async () => {
    const { registry } = await boot()
    await getDb().tools.bulkPut([
      { id: 't1', code: 'TW-017', description: '', calibration_due: '2026-10-22', active: true },
      { id: 't2', code: 'TW-018', description: '', calibration_due: null, active: true },
      { id: 't3', code: 'TW-019', description: '', calibration_due: '2030-01-01', active: false },
    ])
    await registry.hydrate()
    expect(registry.checkTool('TW-017', new Date(2026, 9, 22, 23, 59)).status).toBe('ok')
    expect(registry.checkTool('TW-017', new Date(2026, 9, 23, 0, 1)).status).toBe('expired')
    expect(registry.checkTool(' tw-018 ').status).toBe('ok')
    expect(registry.checkTool('TW-019').status).toBe('inactive')
    expect(registry.checkTool('TW-999')).toEqual({ status: 'unknown', tool: null })
  })

  it('expired tool scan is blocked online but recorded offline', async () => {
    const { runs, registry } = await boot()
    await getDb().tools.put({ id: 't1', code: 'TW-017', description: '', calibration_due: '2000-01-01', active: true })
    await registry.hydrate()
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-T' })
    const scan = () => runs.recordInput({ runId: run.id, stepId: IDS.B, inputId: IDS.B_TOOL, value: 'TW-017', source: 'scan' })
    await expect(scan()).rejects.toMatchObject({ keys: [V + 'toolExpired'] })
    syncState.online.value = false
    const ev = await scan()
    expect(ev.offline).toBe(true)
  })
})

describe('runs store: canEdit (§6)', () => {
  it('online requires own step lock; foreign lock and closed run refuse', async () => {
    const { runs, server, session } = await boot()
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-L' })
    expect(runs.checkoutOf(run.id)).toBeNull() // created online: no implicit checkout
    expect(runs.canEdit(run.id, IDS.A)).toEqual({ ok: false, reason: 'not_locked' })

    server.handlers.push((c) => (c.path.endsWith('/lock') ? json({
      lock_id: 'L1', run_id: run.id, step_id: IDS.A, holder_user: USERS.op!.id, holder_device: session.deviceId,
      expires_at: new Date(Date.now() + 120_000).toISOString() }) : undefined))
    await runs.lockStep(run.id, IDS.A)
    expect(server.callsTo(`/runs/${run.id}/steps/${IDS.A}/lock`)[0]!.body).toEqual({ device_id: session.deviceId })
    expect(runs.canEdit(run.id, IDS.A)).toEqual({ ok: true })
    expect(runs.canEdit(run.id, IDS.C)).toEqual({ ok: false, reason: 'not_locked' })
    expect(runs.locks(run.id)).toHaveLength(1)

    // someone else holds step C: the 409 body teaches us who
    server.handlers.unshift((c) => (c.path.endsWith(`/steps/${IDS.C}/lock`) ? json({ detail: { lock: {
      lock_id: 'L2', run_id: run.id, step_id: IDS.C, holder_user: USERS.sup!.id, holder_device: 'other-device',
      expires_at: new Date(Date.now() + 120_000).toISOString() } } }, 409) : undefined))
    await expect(runs.lockStep(run.id, IDS.C)).rejects.toMatchObject({ status: 409 })
    expect(runs.canEdit(run.id, IDS.C)).toEqual({ ok: false, reason: 'locked_by_other' })

    // going offline without a checkout makes the run read-only
    syncState.online.value = false
    expect(runs.canEdit(run.id, IDS.A)).toEqual({ ok: false, reason: 'offline_not_checked_out' })
    syncState.online.value = true

    await runs.releaseStep(run.id, IDS.A)
    expect(server.callsTo('/locks/L1', 'DELETE')).toHaveLength(1)
    expect(runs.canEdit(run.id, IDS.A)).toEqual({ ok: false, reason: 'not_locked' })
  })

  it('checkout: ok offline for this device, refuses when another device holds it, expired checkout does not count', async () => {
    const { runs, session, server } = await boot()
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-C' })
    const co = await runs.checkout(run.id, 8)
    expect(co.holder_device).toBe(session.deviceId)
    expect(server.callsTo(`/runs/${run.id}/checkout`, 'POST')[0]!.body).toEqual({ device_id: session.deviceId, hours: 8 })
    syncState.online.value = false
    expect(runs.canEdit(run.id, IDS.A)).toEqual({ ok: true })
    syncState.online.value = true

    // a lease held by another device (e.g. learned from a server response)
    server.checkoutDevice = 'other-device'
    await runs.checkout(run.id)
    expect(runs.canEdit(run.id, IDS.A)).toEqual({ ok: false, reason: 'checked_out_by_other' })

    const db = getDb()
    await db.checkouts.put({ run_id: run.id, holder_user: USERS.op!.id, holder_device: session.deviceId, expires_at: new Date(Date.now() + 3600_000).toISOString() })
    await runs.reloadLocal()
    syncState.online.value = false
    expect(runs.canEdit(run.id, IDS.A)).toEqual({ ok: true })

    await db.checkouts.put({ run_id: run.id, holder_user: USERS.op!.id, holder_device: session.deviceId, expires_at: new Date(Date.now() - 1000).toISOString() })
    await runs.reloadLocal()
    expect(runs.canEdit(run.id, IDS.A)).toEqual({ ok: false, reason: 'offline_not_checked_out' })
  })

  it('closed run is read-only', async () => {
    const { runs } = await boot({ user: USERS.sup })
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-X' })
    await runs.abortRun(run.id, 'scrapped')
    expect(runs.getRun(run.id)?.status).toBe('aborted')
    expect(runs.canEdit(run.id, IDS.A)).toEqual({ ok: false, reason: 'run_closed' })
    await expect(runs.addNote(run.id, null, 'late')).rejects.toMatchObject({ keys: [V + 'runClosed'] })
  })
})
