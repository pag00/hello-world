// Execution UI components against real Pinia stores (fake-indexeddb + fake server from tests/helpers).
// Device components are stubbed: tests emit their events directly.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, type Component } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { RouterView, createMemoryHistory, createRouter } from 'vue-router'
import type { Input, Tool } from '../../../domain/types'
import { messages } from '../../../i18n'
import { useRegistryStore, useRunsStore, useSessionStore, useSyncStore } from '../../../stores'
import { getDb, syncState } from '../../../sync/runtime'
import { CONTENT, IDS, REVISION, USERS, json, setup, teardown } from '../../../../tests/helpers'
import NumberField from '../inputs/NumberField.vue'
import ScanField from '../inputs/ScanField.vue'
import PhotoField from '../inputs/PhotoField.vue'
import SignoffField from '../inputs/SignoffField.vue'
import CompleteStepPanel from '../CompleteStepPanel.vue'
import RunStepView from '../../../views/RunStepView.vue'

// ---------------------------------------------------------------------------------------------- harness

function i18n() {
  return createI18n({ legacy: false, locale: 'en', fallbackLocale: 'en', messages: messages as never, missingWarn: false, fallbackWarn: false })
}

const deviceStubs = { ScanButton: true, OcrCaptureButton: true, PhotoCaptureButton: true }

async function boot(opts: Parameters<typeof setup>[0] & { tools?: Tool[]; patchInput?: { id: string; patch: Partial<Input> } } = {}) {
  const { tools, patchInput, ...rest } = opts
  const env = await setup(rest)
  if (tools?.length) await getDb().tools.bulkPut(tools)
  if (patchInput) {
    // the store validates against the revision on the device, so the fixture revision itself is patched
    const content = JSON.parse(JSON.stringify(CONTENT)) as typeof CONTENT
    for (const sec of content.sections) for (const st of sec.steps) {
      st.inputs = st.inputs.map((i) => (i.id === patchInput.id ? ({ ...i, ...patchInput.patch } as Input) : i))
    }
    await getDb().revisions.put({ ...REVISION, content })
  }
  const session = useSessionStore()
  await session.init()
  await useSyncStore().syncNow()
  const registry = useRegistryStore()
  await registry.hydrate()
  const runs = useRunsStore()
  const run = await runs.startRun({ revisionId: REVISION.id, serial: 'SN-T1' })
  return { ...env, session, runs, registry, run }
}

function inputOf(id: string): Input {
  for (const s of CONTENT.sections) for (const st of s.steps) for (const i of st.inputs) if (i.id === id) return i
  throw new Error(`no input ${id}`)
}
function stepOf(id: string) {
  for (const s of CONTENT.sections) for (const st of s.steps) if (st.id === id) return st
  throw new Error(`no step ${id}`)
}

let wrapper: VueWrapper | null = null

/** Mounts a field with its projection state wired reactively, as RunStepView does. */
function mountField(comp: Component, args: { pinia: unknown; runId: string; stepId: string; input: Input; editable?: boolean }) {
  const runs = useRunsStore()
  const raised: unknown[] = []
  const Harness = defineComponent({
    setup() {
      const state = computed(() => runs.projection(args.runId).value?.steps[args.stepId]?.inputs[args.input.id])
      return () => h(comp as never, {
        runId: args.runId, stepId: args.stepId, input: args.input, state: state.value, editable: args.editable ?? true,
        onRaiseNcr: (r: unknown) => raised.push(r),
      })
    },
  })
  wrapper = mount(Harness, { global: { plugins: [args.pinia as never, i18n()], stubs: deviceStubs }, attachTo: document.body })
  return { w: wrapper, raised }
}

async function type(w: VueWrapper, sel: string, value: string) {
  await w.find(sel).setValue(value)
  await nextTick()
}

const text = (w: VueWrapper, sel: string) => (w.find(sel).exists() ? w.find(sel).text() : null)

/** store writes hash with WebCrypto and commit through fake-indexeddb (macrotasks): let them land */
async function settle() {
  for (let i = 0; i < 8; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 5))
  }
}

afterEach(async () => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  syncState.online.value = true
  await teardown()
})

// ---------------------------------------------------------------------------------------------- NumberField

describe('NumberField', () => {
  const torque = () => inputOf(IDS.A_TORQUE) // min 11.5, nominal 12.0, max 12.5, 1 decimal, ocr

  it('shows limits and live tolerance state while typing', async () => {
    const { pinia, run } = await boot()
    const { w } = mountField(NumberField, { pinia, runId: run.id, stepId: IDS.A, input: torque() })
    expect(text(w, '[data-test="limits"]')).toBe('min 11.5 · nom 12.0 · max 12.5 Nm')
    expect(w.find('[data-test="tolerance-bar"]').exists()).toBe(true)
    expect(w.find('[data-test="live-tolerance"]').exists()).toBe(false)

    await type(w, '[data-test="number-draft"]', '12.1')
    expect(text(w, '[data-test="live-tolerance"]')).toBe('Within tolerance')
    expect(w.find('[data-test="record"]').classes()).toContain('st-btn--primary')

    await type(w, '[data-test="number-draft"]', '11.4')
    expect(text(w, '[data-test="live-tolerance"]')).toContain('Below minimum')
    expect(w.find('[data-test="record"]').classes()).toContain('st-btn--danger')
    expect(w.find('[data-test="tolerance-marker"]').classes()).toContain('st-num__marker--out')

    await type(w, '[data-test="number-draft"]', '12.5') // inclusive bound
    expect(text(w, '[data-test="live-tolerance"]')).toBe('Within tolerance')

    await type(w, '[data-test="number-draft"]', '12.55')
    expect(text(w, '[data-test="live-tolerance"]')).toContain('Too many decimal places (exactly 1 allowed)')
    expect(w.find('[data-test="record"]').attributes('disabled')).toBeDefined()

    await type(w, '[data-test="number-draft"]', '12,0') // German keypad
    expect(text(w, '[data-test="live-tolerance"]')).toBe('Within tolerance')
  })

  it('records a manual value and shows who/when/source', async () => {
    const { pinia, run, runs } = await boot()
    const { w } = mountField(NumberField, { pinia, runId: run.id, stepId: IDS.A, input: torque() })
    await type(w, '[data-test="number-draft"]', '12')
    await w.find('[data-test="record"]').trigger('click')
    await settle()
    const ev = runs.events(run.id).at(-1)!
    expect(ev.payload).toEqual({ input_id: IDS.A_TORQUE, value: '12.0', source: 'manual' })
    expect(text(w, '[data-test="number-value"]')).toContain('12.0')
    expect(text(w, '[data-test="recorded-tolerance"]')).toBe('Within tolerance')
    expect(text(w, '[data-test="meta-source"]')).toBe('Entered')
    expect(text(w, '[data-test="recorded-meta"]')).toContain(USERS.op!.name)
    expect(w.find('[data-test="number-draft"]').exists()).toBe(false)
  })

  it('OCR: reading fills the draft, recording sends source "ocr" with the raw text; editing makes it manual', async () => {
    const { pinia, run, runs } = await boot()
    const spy = vi.fn(async () => runs.events(run.id)[0]!)
    runs.recordInput = spy as never
    const { w } = mountField(NumberField, { pinia, runId: run.id, stepId: IDS.A, input: torque() })
    const ocr = w.findComponent({ name: 'OcrCaptureButton' })
    expect(ocr.exists()).toBe(true)
    expect(ocr.props()).toMatchObject({ decimals: 1, unit: 'Nm' })

    ocr.vm.$emit('read', { value: '12.3', raw: '12.3 Nm', confidence: 0.91 })
    await nextTick()
    expect((w.find('[data-test="number-draft"]').element as HTMLInputElement).value).toBe('12.3')
    expect(w.find('[data-test="draft-ocr"]').exists()).toBe(true)
    expect(text(w, '[data-test="live-tolerance"]')).toBe('Within tolerance')
    await w.find('[data-test="record"]').trigger('click')
    await settle()
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ inputId: IDS.A_TORQUE, value: '12.3', source: 'ocr', ocrRaw: '12.3 Nm', supersedes: null }))

    // OCR again, then the operator corrects the reading by hand → manual, no ocr_raw
    ocr.vm.$emit('read', { value: '18.3', raw: '18.3', confidence: 0.4 })
    await nextTick()
    await type(w, '[data-test="number-draft"]', '12.3')
    expect(w.find('[data-test="draft-ocr"]').exists()).toBe(false)
    await w.find('[data-test="record"]').trigger('click')
    await settle()
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ value: '12.3', source: 'manual', ocrRaw: undefined }))
  })

  it('no OCR button when the input does not allow OCR', async () => {
    const { pinia, run } = await boot()
    const { w } = mountField(NumberField, { pinia, runId: run.id, stepId: IDS.A, input: { ...(torque() as object), ocr: false } as Input })
    expect(w.findComponent({ name: 'OcrCaptureButton' }).exists()).toBe(false)
  })

  it('out-of-tolerance value is recorded as measured and offers a prefilled NCR until one exists', async () => {
    const { pinia, run, runs } = await boot()
    const { w, raised } = mountField(NumberField, { pinia, runId: run.id, stepId: IDS.A, input: torque() })
    await type(w, '[data-test="number-draft"]', '12.9')
    expect(text(w, '[data-test="record"]')).toBe('Record (out of tolerance)')
    await w.find('[data-test="record"]').trigger('click')
    await settle()
    expect(runs.events(run.id).at(-1)!.payload).toMatchObject({ value: '12.9' })
    expect(text(w, '[data-test="recorded-tolerance"]')).toContain('Above maximum')
    expect(runs.projection(run.id).value!.steps[IDS.A]!.block_reasons).toContain('out_of_tolerance')

    await w.find('[data-test="raise-ncr"]').trigger('click')
    expect(raised).toEqual([{ inputId: IDS.A_TORQUE, prefill: 'Torque: measured 12.9 Nm, limits 11.5 to 12.5 Nm.' }])

    await runs.raiseNcr({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, description: 'over torque' })
    await settle()
    expect(w.find('[data-test="raise-ncr"]').exists()).toBe(false)
    expect(text(w, '[data-test="recorded-tolerance"]')).toContain('An NCR covers this value.')
  })

  it('correction needs a reason, supersedes the previous value and writes the reason as a note', async () => {
    const { pinia, run, runs } = await boot()
    const first = await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, value: '12.0', source: 'manual' })
    const { w } = mountField(NumberField, { pinia, runId: run.id, stepId: IDS.A, input: torque() })
    await settle()
    await w.find('[data-test="correct"]').trigger('click')
    await type(w, '[data-test="number-draft"]', '12.2')
    await w.find('[data-test="record"]').trigger('click')
    await settle()
    expect(text(w, '[data-test="field-error"]')).toBe('Enter a reason for the correction.')
    expect(runs.events(run.id).filter((e) => e.type === 'input.recorded')).toHaveLength(1)

    await type(w, '[data-test="correction-reason"]', 'misread the dial')
    await w.find('[data-test="record"]').trigger('click')
    await settle()
    const evs = runs.events(run.id)
    const corr = evs.find((e) => e.type === 'input.recorded' && e.id !== first.id)!
    expect(corr.supersedes).toBe(first.id)
    expect(corr.payload).toMatchObject({ value: '12.2' })
    const note = evs.find((e) => e.type === 'note.added')!
    expect(note.step_id).toBe(IDS.A)
    expect((note.payload as { text: string }).text).toBe(`Correction of "Torque" (supersedes ${first.id}): misread the dial`)
    expect(text(w, '[data-test="number-value"]')).toContain('12.2')
    await w.find('.st-meta__toggle').trigger('click')
    expect(text(w, '[data-test="meta-history"]')).toContain('12.0 Nm')
  })

  it('read-only: no editor, no correction', async () => {
    const { pinia, run } = await boot()
    const { w } = mountField(NumberField, { pinia, runId: run.id, stepId: IDS.A, input: torque(), editable: false })
    expect(w.find('[data-test="number-draft"]').exists()).toBe(false)
    expect(w.find('[data-test="correct"]').exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------- ScanField

describe('ScanField', () => {
  const tool = () => inputOf(IDS.B_TOOL) // entity tool, no expect
  const TOOLS: Tool[] = [
    { id: 't1', code: 'TW-017', description: 'Torque wrench 5–25 Nm', calibration_due: '2000-01-01', active: true },
    { id: 't2', code: 'TW-018', description: 'Torque wrench 2–10 Nm', calibration_due: '2999-01-01', active: true },
  ]

  it('enforces an exact expected value', async () => {
    const patch = { entity: 'part', expect: 'PN-4711' } as Partial<Input>
    const { pinia, run, runs } = await boot({ patchInput: { id: IDS.B_TOOL, patch } })
    const input = { ...inputOf(IDS.B_TOOL), ...patch } as Input
    const { w } = mountField(ScanField, { pinia, runId: run.id, stepId: IDS.B, input })
    expect(text(w, '[data-test="expect-hint"]')).toBe('Expected: PN-4711')
    const scan = w.findComponent({ name: 'ScanButton' })
    expect(scan.props('expect')).toBe('PN-4711')
    scan.vm.$emit('scanned', 'PN-4712')
    await settle()
    expect(w.findAll('[data-test="field-error"]').map((e) => e.text())).toEqual(['"PN-4712" is not what this step expects.', 'Expected: PN-4711'])
    expect(runs.events(run.id).some((e) => e.type === 'input.recorded')).toBe(false)

    scan.vm.$emit('scanned', ' PN-4711 ')
    await settle()
    expect(runs.events(run.id).at(-1)!.payload).toEqual({ input_id: IDS.B_TOOL, value: 'PN-4711', source: 'scan' })
    expect(text(w, '[data-test="scan-value"]')).toBe('PN-4711')
    expect(w.find('[data-test="field-error"]').exists()).toBe(false)
  })

  it('enforces a /regex/ expectation, also for typed entry', async () => {
    const patch = { entity: 'part', expect: '/^SN-\\d{4}$/' } as Partial<Input>
    const { pinia, run, runs } = await boot({ patchInput: { id: IDS.B_TOOL, patch } })
    const input = { ...inputOf(IDS.B_TOOL), ...patch } as Input
    const { w } = mountField(ScanField, { pinia, runId: run.id, stepId: IDS.B, input })
    expect(text(w, '[data-test="expect-hint"]')).toBe('Expected format: /^SN-\\d{4}$/')
    await w.find('[data-test="type-instead"]').trigger('click')
    await type(w, '[data-test="scan-typed"]', 'SN-12')
    await w.find('[data-test="record"]').trigger('click')
    await settle()
    expect(text(w, '[data-test="field-error"]')).toContain('"SN-12" is not what this step expects.')
    await type(w, '[data-test="scan-typed"]', 'SN-1234')
    await w.find('[data-test="record"]').trigger('click')
    await settle()
    expect(runs.events(run.id).at(-1)!.payload).toEqual({ input_id: IDS.B_TOOL, value: 'SN-1234', source: 'manual' })
  })

  it('online: expired or unknown tool is refused and nothing is recorded', async () => {
    const { pinia, run, runs } = await boot({ tools: TOOLS })
    const spy = vi.spyOn(runs, 'recordInput')
    const { w } = mountField(ScanField, { pinia, runId: run.id, stepId: IDS.B, input: tool() })
    const scan = w.findComponent({ name: 'ScanButton' })
    scan.vm.$emit('scanned', 'TW-017')
    await settle()
    expect(text(w, '[data-test="field-error"]')).toBe('Tool TW-017: calibration expired. Use a calibrated tool.')
    scan.vm.$emit('scanned', 'TW-999')
    await settle()
    expect(text(w, '[data-test="field-error"]')).toBe('Tool TW-999 is not in the tool register.')
    expect(spy).not.toHaveBeenCalled()

    scan.vm.$emit('scanned', 'TW-018')
    await settle()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(text(w, '[data-test="scan-value"]')).toBe('TW-018')
    expect(w.find('[data-test="tool-problem"]').exists()).toBe(false)
  })

  it('offline: expired tool warns, records only on confirmation, then requires an NCR', async () => {
    const { pinia, run, runs } = await boot({ tools: TOOLS })
    await runs.checkout(run.id)
    syncState.online.value = false
    const { w, raised } = mountField(ScanField, { pinia, runId: run.id, stepId: IDS.B, input: tool() })
    w.findComponent({ name: 'ScanButton' }).vm.$emit('scanned', 'TW-017')
    await settle()
    expect(text(w, '[data-test="offline-tool-warning"]')).toContain('calibration expired')
    expect(runs.events(run.id).some((e) => e.type === 'input.recorded')).toBe(false)

    await w.find('[data-test="record-anyway"]').trigger('click')
    await settle()
    const ev = runs.events(run.id).at(-1)!
    expect(ev.payload).toEqual({ input_id: IDS.B_TOOL, value: 'TW-017', source: 'scan' })
    expect(ev.offline).toBe(true)
    expect(text(w, '[data-test="tool-problem"]')).toContain('Calibration expired')
    await w.find('[data-test="raise-ncr"]').trigger('click')
    expect(raised).toEqual([{ inputId: IDS.B_TOOL, prefill: 'Torque wrench: tool TW-017 used — Calibration expired' }])
  })
})

// ---------------------------------------------------------------------------------------------- PhotoField

describe('PhotoField', () => {
  const photo = () => inputOf(IDS.B_PHOTO) // min 1, max 3

  it('records each capture; additions supersede the list without a reason; max count enforced', async () => {
    const { pinia, run, runs } = await boot()
    const { w } = mountField(PhotoField, { pinia, runId: run.id, stepId: IDS.B, input: photo() })
    expect(text(w, '[data-test="photo-count"]')).toBe('0 (min 1, max 3)')
    const cam = w.findComponent({ name: 'PhotoCaptureButton' })
    const shot = (s: string) => new Blob([s], { type: 'image/jpeg' })

    cam.vm.$emit('captured', shot('one'))
    await settle()
    const e1 = runs.events(run.id).at(-1)!
    expect(e1.type).toBe('input.recorded')
    expect((e1.payload as { value: string[] }).value).toHaveLength(1)
    expect((e1.payload as { value: string[] }).value[0]).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(e1.supersedes).toBeNull()

    cam.vm.$emit('captured', shot('two'))
    await settle()
    const e2 = runs.events(run.id).at(-1)!
    expect(e2.supersedes).toBe(e1.id)
    expect((e2.payload as { value: string[] }).value).toEqual([...(e1.payload as { value: string[] }).value, expect.stringMatching(/^sha256:/)])
    expect(runs.events(run.id).some((e) => e.type === 'note.added')).toBe(false)

    // the very same photo again is not added twice
    cam.vm.$emit('captured', shot('two'))
    await settle()
    expect(text(w, '[data-test="field-error"]')).toBe('This exact photo is already recorded.')

    cam.vm.$emit('captured', shot('three'))
    await settle()
    expect(text(w, '[data-test="photo-count"]')).toBe('3 (min 1, max 3)')
    expect(w.findComponent({ name: 'PhotoCaptureButton' }).props('disabled')).toBe(true)
    expect(runs.events(run.id).filter((e) => e.type === 'input.recorded')).toHaveLength(3)
  })

  it('removing photos is a correction with a reason', async () => {
    const { pinia, run, runs } = await boot()
    const a = 'sha256:' + 'a'.repeat(64)
    const b = 'sha256:' + 'b'.repeat(64)
    const first = await runs.recordInput({ runId: run.id, stepId: IDS.B, inputId: IDS.B_PHOTO, value: [a, b], source: 'manual' })
    const { w } = mountField(PhotoField, { pinia, runId: run.id, stepId: IDS.B, input: photo() })
    await settle()
    await w.find('[data-test="correct"]').trigger('click')
    await w.findAll('[data-test="photo-remove"]')[1]!.trigger('click')
    await w.find('[data-test="correction-reason"]').setValue('blurred')
    await w.find('[data-test="record"]').trigger('click')
    await settle()
    const evs = runs.events(run.id)
    const corr = evs.filter((e) => e.type === 'input.recorded').at(-1)!
    expect(corr.supersedes).toBe(first.id)
    expect((corr.payload as { value: string[] }).value).toEqual([a])
    expect((evs.find((e) => e.type === 'note.added')!.payload as { text: string }).text).toContain('blurred')
  })
})

// ---------------------------------------------------------------------------------------------- SignoffField

describe('SignoffField', () => {
  it('records true signed by the person confirmed in the PIN dialog, with the required role', async () => {
    const { pinia, run, runs } = await boot()
    const input = { ...inputOf(IDS.C_SIGN), role: null } as Input
    const { w } = mountField(SignoffField, { pinia, runId: run.id, stepId: IDS.C, input })
    await w.find('[data-test="signoff"]').trigger('click')
    await settle()
    const dialog = w.findComponent({ name: 'PinDialog' })
    expect(dialog.props('open')).toBe(true)
    dialog.vm.$emit('signed', { user: USERS.sup!, auth_method: 'pin' })
    await settle()
    const ev = runs.events(run.id).at(-1)!
    expect(ev).toMatchObject({ type: 'input.recorded', actor_id: USERS.sup!.id, auth_method: 'pin', payload: { value: true } })
    expect(text(w, '[data-test="signoff-done"]')).toContain(`Signed off by ${USERS.sup!.name}`)
    expect(w.find('[data-test="signoff"]').exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------- CompleteStepPanel

describe('CompleteStepPanel', () => {
  function mountPanel(pinia: unknown, runId: string, stepId: string, editable = true) {
    wrapper = mount(CompleteStepPanel, {
      props: { runId, step: stepOf(stepId), editable },
      global: { plugins: [pinia as never, i18n()], stubs: deviceStubs },
      attachTo: document.body,
    })
    return wrapper
  }

  it('lists problems and keeps the button disabled until the step can be completed', async () => {
    const { pinia, run, runs } = await boot()
    const w = mountPanel(pinia, run.id, IDS.A)
    expect(w.findAll('[data-test="complete-problems"] li').map((li) => li.text())).toEqual(['Fill in all required inputs first.'])
    expect(w.find('[data-test="complete-step"]').attributes('disabled')).toBeDefined()

    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_CHECK, value: true, source: 'manual' })
    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, value: '13.0', source: 'manual' })
    await settle()
    expect(w.findAll('[data-test="complete-problems"] li').map((li) => li.text())).toEqual([
      'A value is out of tolerance. Raise an NCR before completing the step.',
    ])
    expect(w.find('[data-test="complete-step"]').attributes('disabled')).toBeDefined()

    await runs.raiseNcr({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, description: 'over torque' })
    await settle()
    expect(w.find('[data-test="complete-problems"]').exists()).toBe(false)
    expect(w.find('[data-test="complete-step"]').attributes('disabled')).toBeUndefined()

    await w.find('[data-test="complete-step"]').trigger('click')
    await settle()
    expect(runs.projection(run.id).value!.steps[IDS.A]!.state).toBe('completed')
    expect(w.emitted('completed')).toHaveLength(1)
  })

  it('disabled while the step is not editable, even without problems', async () => {
    const { pinia, run, runs } = await boot()
    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_CHECK, value: true, source: 'manual' })
    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, value: '12.0', source: 'manual' })
    const w = mountPanel(pinia, run.id, IDS.A, false)
    await settle()
    expect(w.find('[data-test="complete-problems"]').exists()).toBe(false)
    expect(w.find('[data-test="complete-step"]').attributes('disabled')).toBeDefined()
  })

  it('offline: a tool that is invalid in the local register needs an NCR before completion', async () => {
    const { pinia, run, runs } = await boot({
      tools: [{ id: 't1', code: 'TW-017', description: '', calibration_due: '2000-01-01', active: true }],
    })
    const sp = 'sha256:' + 'a'.repeat(64)
    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_CHECK, value: true, source: 'manual' })
    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, value: '12.0', source: 'manual' })
    await runs.completeStep(run.id, IDS.A)
    await runs.checkout(run.id)
    syncState.online.value = false
    await runs.recordInput({ runId: run.id, stepId: IDS.B, inputId: IDS.B_PHOTO, value: [sp], source: 'manual' })
    await runs.recordInput({ runId: run.id, stepId: IDS.B, inputId: IDS.B_TOOL, value: 'TW-017', source: 'scan' })
    // shared validation alone would allow it (the server has not flagged it yet)
    expect(runs.validateComplete(run.id, IDS.B)).toEqual([])
    const w = mountPanel(pinia, run.id, IDS.B)
    await settle()
    expect(w.findAll('[data-test="complete-problems"] li').map((li) => li.text())).toEqual([
      'A tool recorded offline is not valid in the register. Raise an NCR before completing the step.',
    ])
    expect(w.find('[data-test="complete-step"]').attributes('disabled')).toBeDefined()
    await runs.raiseNcr({ runId: run.id, stepId: IDS.B, inputId: IDS.B_TOOL, description: 'expired wrench used' })
    await settle()
    expect(w.find('[data-test="complete-step"]').attributes('disabled')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------- RunStepView

describe('RunStepView', () => {
  async function mountStep(pinia: unknown, runId: string, stepId: string) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/runs/:runId', name: 'st-run', component: { render: () => null } },
        { path: '/runs/:runId/steps/:stepId', name: 'st-run-step', component: RunStepView, props: true },
        { path: '/runs/:runId/record', name: 'st-run-record', component: { render: () => null } },
        { path: '/runs/:runId/traveller', name: 'st-run-traveller', component: { render: () => null } },
        { path: '/runs', name: 'st-runs', component: { render: () => null } },
        { path: '/ncrs/:ncrId', name: 'st-ncr', component: { render: () => null } },
      ],
    })
    await router.push({ name: 'st-run-step', params: { runId, stepId } })
    await router.isReady()
    const App = defineComponent({ render: () => h(RouterView) })
    wrapper = mount(App, { global: { plugins: [pinia as never, i18n(), router], stubs: deviceStubs }, attachTo: document.body })
    await settle()
    return { w: wrapper, router }
  }

  it('acquires the step lock on enter, enables inputs, releases on leave', async () => {
    const { pinia, run, server } = await boot()
    const { w, router } = await mountStep(pinia, run.id, IDS.A)
    await vi.waitFor(() => expect(server.callsTo(`/runs/${run.id}/steps/${IDS.A}/lock`, 'POST')).toHaveLength(1))
    await settle()
    expect(w.find('[data-test="readonly-banner"]').exists()).toBe(false)
    expect(w.find('[data-test="number-draft"]').exists()).toBe(true)

    // moving to the next step releases A and takes B
    await router.push({ name: 'st-run-step', params: { runId: run.id, stepId: IDS.B } })
    await settle()
    await vi.waitFor(() => expect(server.callsTo(`/runs/${run.id}/steps/${IDS.B}/lock`, 'POST')).toHaveLength(1))
    expect(server.calls.filter((c) => c.method === 'DELETE' && c.path.startsWith('/locks/'))).toHaveLength(1)

    await router.push({ name: 'st-run', params: { runId: run.id } })
    await settle()
    await vi.waitFor(() => expect(server.calls.filter((c) => c.method === 'DELETE' && c.path.startsWith('/locks/'))).toHaveLength(2))
  })

  it('lock refused: read-only with the holder; supervisor can force a take-over (logged)', async () => {
    const { pinia, run, server, runs } = await boot({ user: USERS.sup })
    let refuse = true
    server.handlers.unshift((c) => {
      if (!c.path.endsWith(`/steps/${IDS.A}/lock`) || c.method !== 'POST') return undefined
      if (refuse) {
        return json({ detail: { lock: {
          lock_id: 'L-other', run_id: run.id, step_id: IDS.A, holder_user: USERS.op!.id, holder_device: 'other-device',
          expires_at: new Date(Date.now() + 120_000).toISOString() } } }, 409)
      }
      return undefined
    })
    const { w } = await mountStep(pinia, run.id, IDS.A)
    await vi.waitFor(() => expect(w.find('[data-test="lock-takeover"]').exists()).toBe(true))
    expect(text(w, '[data-test="readonly-banner"]')).toContain(`${USERS.op!.name} is working on this step on another tablet`)
    expect(w.find('[data-test="number-draft"]').exists()).toBe(false)
    expect(w.find('[data-test="complete-step"]').attributes('disabled')).toBeDefined()

    refuse = false
    await w.find('[data-test="lock-takeover"]').trigger('click')
    await settle()
    ;(document.querySelector('[data-test="reason-confirm"]') as HTMLButtonElement).click()
    await settle()
    await vi.waitFor(() => expect(w.find('[data-test="readonly-banner"]').exists()).toBe(false))
    const forced = server.callsTo(`/runs/${run.id}/steps/${IDS.A}/lock`, 'POST').at(-1)!
    expect(forced.body).toMatchObject({ force: true })
    const note = runs.events(run.id).find((e) => e.type === 'note.added')!
    expect(note.payload).toMatchObject({ system: 'lock_takeover' })
    expect(w.find('[data-test="number-draft"]').exists()).toBe(true)
  })

  it('operators get no take-over button', async () => {
    const { pinia, run, server } = await boot()
    server.handlers.unshift((c) => (c.path.endsWith(`/steps/${IDS.A}/lock`) && c.method === 'POST' ? json({ detail: 'locked' }, 409) : undefined))
    const { w } = await mountStep(pinia, run.id, IDS.A)
    await vi.waitFor(() => expect(w.find('[data-test="readonly-banner"]').exists()).toBe(true))
    expect(w.find('[data-test="lock-takeover"]').exists()).toBe(false)
    expect(w.find('[data-test="lock-retry"]').exists()).toBe(true)
    expect(text(w, '[data-test="readonly-banner"]')).toContain('Another tablet holds this step')
  })

  it('offline without checkout: read-only banner explains why, no lock request', async () => {
    const { pinia, run, server } = await boot()
    syncState.online.value = false
    server.online = false
    const { w } = await mountStep(pinia, run.id, IDS.A)
    expect(text(w, '[data-test="readonly-banner"]')).toContain('not checked out to this tablet')
    expect(server.callsTo(`/runs/${run.id}/steps/`)).toHaveLength(0)
    expect(w.find('[data-test="number-draft"]').exists()).toBe(false)
  })

  it('verification: inspector signs, completer is excluded', async () => {
    const { pinia, run, runs } = await boot({
      tools: [{ id: 't2', code: 'TW-018', description: '', calibration_due: '2999-01-01', active: true }],
    })
    const sp = 'sha256:' + 'b'.repeat(64)
    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_CHECK, value: true, source: 'manual' })
    await runs.recordInput({ runId: run.id, stepId: IDS.A, inputId: IDS.A_TORQUE, value: '12.0', source: 'manual' })
    await runs.completeStep(run.id, IDS.A)
    await runs.recordInput({ runId: run.id, stepId: IDS.B, inputId: IDS.B_PHOTO, value: [sp], source: 'manual' })
    await runs.recordInput({ runId: run.id, stepId: IDS.B, inputId: IDS.B_TOOL, value: 'TW-018', source: 'scan' })
    await runs.completeStep(run.id, IDS.B)
    expect(runs.projection(run.id).value!.steps[IDS.B]!.state).toBe('completed')

    const { w } = await mountStep(pinia, run.id, IDS.B)
    await vi.waitFor(() => expect(w.find('[data-test="verify"]').attributes('disabled')).toBeUndefined())
    expect(w.find('[data-test="complete-panel"]').exists()).toBe(false)
    expect(text(w, '[data-test="done-banner"]')).toContain('This step is completed')
    expect(text(w, '[data-test="completion-info"]')).toContain(`Completed by ${USERS.op!.name}`)
    await w.find('[data-test="verify"]').trigger('click')
    await settle()
    const dialog = w.findAllComponents({ name: 'PinDialog' }).find((c) => c.props('open'))!
    expect(dialog.props('role')).toBe('inspector')
    expect(dialog.props('excludeUserIds')).toEqual([USERS.op!.id])

    // the inspector signs (PIN on this tablet) → step.verified by the inspector
    dialog.vm.$emit('signed', { user: USERS.insp!, auth_method: 'pin' })
    await settle()
    const ver = runs.events(run.id).at(-1)!
    expect(ver.type).toBe('step.verified')
    expect(ver.actor_id).toBe(USERS.insp!.id)
    expect(ver.auth_method).toBe('pin')
    expect(runs.projection(run.id).value!.steps[IDS.B]!.state).toBe('verified')
  })
})

