// Route-level execution views mounted with a real router and stores.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { RouterView, createMemoryHistory, createRouter, type Router } from 'vue-router'
import type { Tool } from '../../../domain/types'
import { messages } from '../../../i18n'
import { useRegistryStore, useRunsStore, useSessionStore, useSyncStore } from '../../../stores'
import { getDb, syncState } from '../../../sync/runtime'
import { IDS, REVISION, PROCEDURE, USERS, setup, teardown } from '../../../../tests/helpers'
import HomeView from '../../../views/HomeView.vue'
import RunListView from '../../../views/RunListView.vue'
import RunStartView from '../../../views/RunStartView.vue'
import RunView from '../../../views/RunView.vue'
import RunStepView from '../../../views/RunStepView.vue'
import QrResolveView from '../../../views/QrResolveView.vue'

const Empty = { render: () => null }

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'st-home', component: HomeView },
      { path: '/runs', name: 'st-runs', component: RunListView },
      { path: '/runs/new', name: 'st-run-new', component: RunStartView },
      { path: '/runs/:runId', name: 'st-run', component: RunView, props: true },
      { path: '/runs/:runId/steps/:stepId', name: 'st-run-step', component: RunStepView, props: true },
      { path: '/q/:kind/:rest(.*)*', name: 'st-qr', component: QrResolveView },
      { path: '/runs/:runId/record', name: 'st-run-record', component: Empty },
      { path: '/runs/:runId/traveller', name: 'st-run-traveller', component: Empty },
      { path: '/ncrs/:ncrId', name: 'st-ncr', component: Empty },
    ],
  })
}

let wrapper: VueWrapper | null = null

async function boot(opts: Parameters<typeof setup>[0] & { tools?: Tool[] } = {}) {
  const { tools, ...rest } = opts
  const env = await setup(rest)
  if (tools?.length) await getDb().tools.bulkPut(tools)
  await useSessionStore().init()
  await useSyncStore().syncNow()
  await useRegistryStore().hydrate()
  return { ...env, runs: useRunsStore(), session: useSessionStore() }
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function open(pinia: unknown, to: Parameters<Router['push']>[0]) {
  const router = makeRouter()
  await router.push(to)
  await router.isReady()
  const i18n = createI18n({ legacy: false, locale: 'en', messages: messages as never, missingWarn: false, fallbackWarn: false })
  wrapper = mount(defineComponent({ render: () => h(RouterView) }), {
    global: { plugins: [pinia as never, i18n, router], stubs: { ScanButton: true, OcrCaptureButton: true, PhotoCaptureButton: true } },
    attachTo: document.body,
  })
  await settle()
  return { w: wrapper, router }
}

afterEach(async () => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  syncState.online.value = true
  await teardown()
})

describe('HomeView', () => {
  it('lists released procedures, this tablet\'s runs, and explains offline mode', async () => {
    const { pinia, runs } = await boot()
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-H1' })
    const { w } = await open(pinia, { name: 'st-home' })
    expect(w.find('[data-test="offline-banner"]').exists()).toBe(false)
    expect(w.find(`[data-test="device-run-${run.id}"]`).text()).toContain('SN-H1')
    expect(w.find(`[data-test="device-run-${run.id}"]`).text()).toContain('0 of 3 steps done')
    expect(w.find('[data-test="start-run"]').text()).toContain(PROCEDURE.number)

    syncState.online.value = false
    await settle()
    expect(w.find('[data-test="offline-banner"]').text()).toContain('checked out to this tablet')
  })

  it('scan of a workstation label jumps to the step of the active run', async () => {
    const { pinia, runs } = await boot()
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-H2' })
    const { w, router } = await open(pinia, { name: 'st-home' })
    w.findComponent({ name: 'ScanButton' }).vm.$emit('scanned', 'st:ws:WS-02')
    await settle()
    expect(router.currentRoute.value.name).toBe('st-run-step')
    expect(router.currentRoute.value.params).toEqual({ runId: run.id, stepId: IDS.C })
  })

  it('tool label shows calibration status', async () => {
    const { pinia } = await boot({ tools: [{ id: 't', code: 'TW-017', description: 'Wrench', calibration_due: '2000-01-01', active: true }] })
    const { w } = await open(pinia, { name: 'st-home' })
    w.findComponent({ name: 'ScanButton' }).vm.$emit('scanned', 'st:tool:TW-017')
    await settle()
    expect(w.find('[data-test="qr-tool-status"]').text()).toContain('Calibration expired')
  })
})

describe('QrResolveView', () => {
  it('workstation deep link replaces itself with the first actionable step', async () => {
    const { pinia, runs } = await boot()
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-Q1' })
    runs.activeRunId = null
    const { router } = await open(pinia, '/q/ws/WS-01')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('st-run-step'))
    expect(router.currentRoute.value.params).toEqual({ runId: run.id, stepId: IDS.A })
    expect(runs.activeRunId).toBe(run.id)
  })

  it('unknown label explains itself', async () => {
    const { pinia } = await boot()
    const { w } = await open(pinia, '/q/ws/')
    expect(w.find('[data-test="qr-result"]').text()).toContain('not a StepTrack label')
  })

  it('part label without a run offers to start one with that serial', async () => {
    const { pinia } = await boot()
    const { w } = await open(pinia, '/q/part/PN-1/SN-NEW')
    expect(w.find('[data-test="qr-result"]').text()).toContain('Start a run for SN-NEW')
  })
})

describe('RunStartView', () => {
  it('starts a run of the preselected procedure and opens it', async () => {
    const { pinia, runs } = await boot()
    const { w, router } = await open(pinia, { name: 'st-run-new', query: { procedureId: PROCEDURE.id } })
    expect((w.find('[data-test="start-procedure"]').element as HTMLSelectElement).value).toBe(PROCEDURE.id)
    expect(w.find('[data-test="start-submit"]').attributes('disabled')).toBeDefined()
    w.findComponent({ name: 'ScanButton' }).vm.$emit('scanned', 'st:part:PN-9:SN-555')
    await settle()
    expect((w.find('[data-test="start-serial"]').element as HTMLInputElement).value).toBe('SN-555')
    await w.find('[data-test="start-wo"]').setValue('WO-1')
    await w.find('form').trigger('submit')
    await settle()
    const run = runs.runs.find((r) => r.serial === 'SN-555')!
    expect(run.work_order).toBe('WO-1')
    expect(router.currentRoute.value).toMatchObject({ name: 'st-run', params: { runId: run.id } })
  })

  it('warns about an open run with the same serial', async () => {
    const { pinia, runs } = await boot()
    await runs.startRun({ revisionId: REVISION.id, serial: 'SN-DUP' })
    const { w } = await open(pinia, { name: 'st-run-new', query: { procedureId: PROCEDURE.id, serial: 'sn-dup' } })
    expect(w.find('[data-test="start-duplicate"]').exists()).toBe(true)
  })
})

describe('RunListView', () => {
  it('filters by status and searches serials', async () => {
    const { pinia, runs } = await boot({ user: USERS.sup })
    const a = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-100' })
    const b = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-200' })
    await runs.abortRun(b.id, 'scrapped')
    const { w, router } = await open(pinia, { name: 'st-runs' })
    expect(w.find(`[data-test="run-${a.id}"]`).exists()).toBe(true)
    expect(w.find(`[data-test="run-${b.id}"]`).exists()).toBe(false) // default: open runs
    await w.find('[data-test="filter-aborted"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query.status).toBe('aborted')
    expect(w.find(`[data-test="run-${b.id}"]`).exists()).toBe(true)
    expect(w.find(`[data-test="run-${a.id}"]`).exists()).toBe(false)
    await w.find('[data-test="filter-all"]').trigger('click')
    await w.find('[data-test="run-search"]').setValue('200')
    await settle()
    expect(w.find(`[data-test="run-${b.id}"]`).exists()).toBe(true)
    expect(w.find(`[data-test="run-${a.id}"]`).exists()).toBe(false)
  })
})

describe('RunView', () => {
  it('shows steps with states and dependency hints, next step, and sets the active run', async () => {
    const { pinia, runs } = await boot()
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-R1' })
    runs.activeRunId = null
    const { w } = await open(pinia, { name: 'st-run', params: { runId: run.id } })
    expect(w.find('[data-test="run-serial"]').text()).toBe('SN-R1')
    expect(w.find(`[data-test="step-row-${IDS.B}"]`).text()).toContain('Waits for: 1.1 Torque M6 bolts')
    expect(w.find(`[data-test="step-row-${IDS.A}"]`).text()).toContain('Not started')
    expect(w.find('[data-test="next-step"]').text()).toContain('1.1 Torque M6 bolts')
    expect(runs.activeRunId).toBe(run.id)
    // operators cannot close runs
    expect(w.find('[data-test="run-close"]').exists()).toBe(false)
    expect(w.find('[data-test="checkout-panel"]').text()).toContain('Check out to this tablet')
  })

  it('out-of-tolerance shows the block reason; supervisor sees complete (disabled) and abort', async () => {
    const { pinia, runs } = await boot({ user: USERS.sup })
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-R2' })
    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, value: '13.0', source: 'manual' })
    const { w } = await open(pinia, { name: 'st-run', params: { runId: run.id } })
    expect(w.find(`[data-test="step-row-${IDS.A}"]`).text()).toContain('Out of tolerance — NCR needed')
    expect(w.find('[data-test="complete-run"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-test="complete-run-reasons"]').text()).toContain('3 steps are not done yet.')

    await w.find('[data-test="abort-run"]').trigger('click')
    await settle()
    const input = document.querySelector<HTMLTextAreaElement>('[data-test="reason-input"]')!
    input.value = 'unit dropped'
    input.dispatchEvent(new Event('input'))
    await settle()
    document.querySelector<HTMLButtonElement>('[data-test="reason-confirm"]')!.click()
    await settle()
    expect(runs.events(run.id).at(-1)).toMatchObject({ type: 'run.aborted', payload: { reason: 'unit dropped' } })
    expect(w.text()).toContain('Run aborted.')
  })

  it('checkout and release from the run page', async () => {
    const { pinia, runs, session } = await boot()
    const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-R3' })
    const { w } = await open(pinia, { name: 'st-run', params: { runId: run.id } })
    await w.find('[data-test="checkout"]').trigger('click')
    await settle()
    expect(runs.checkoutOf(run.id)?.holder_device).toBe(session.deviceId)
    expect(w.find('[data-test="checkout-mine"]').exists()).toBe(true)
    await w.find('[data-test="checkout-release"]').trigger('click')
    await settle()
    expect(runs.checkoutOf(run.id)).toBeNull()
    expect(w.find('[data-test="checkout-panel"]').text()).toContain('Checkout released')
  })

  it('unknown run explains it is not on this device', async () => {
    const { pinia } = await boot()
    const { w } = await open(pinia, { name: 'st-run', params: { runId: '0190f000-0000-7000-8000-00000000dead' } })
    expect(w.find('[data-test="run-missing"]').exists()).toBe(true)
  })
})
