// Device components against fake adapters injected through window.__STEPTRACK_TEST_DEVICE__
// (the same hook the e2e tests use).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Component } from 'vue'
import { messages } from '../../i18n'
import type { CameraAdapter, DeviceAdapters, OcrAdapter, OcrResult, ScannerAdapter, ScanResult } from '../../device/types'
import { DeviceError } from '../../device/errors'
import ScanButton from './ScanButton.vue'
import OcrCaptureButton from './OcrCaptureButton.vue'
import PhotoCaptureButton from './PhotoCaptureButton.vue'

const wrappers: VueWrapper[] = []

function i18n() {
  return createI18n({ legacy: false, locale: 'en', fallbackLocale: 'en', messages: messages as never, missingWarn: false, fallbackWarn: false })
}

function inject(d: Partial<DeviceAdapters>) {
  window.__STEPTRACK_TEST_DEVICE__ = d
}

function mountIt<T extends Component>(c: T, props: Record<string, unknown> = {}) {
  const w = mount(c as never, { props, attachTo: document.body, global: { plugins: [i18n()] } } as never) as VueWrapper
  wrappers.push(w)
  return w
}

/** Teleported content lives in document.body, outside the wrapper. */
const $ = (sel: string) => document.body.querySelector<HTMLElement>(sel)
const click = async (sel: string) => {
  const el = $(sel)
  if (!el) throw new Error(`missing ${sel}`)
  el.click()
  await flushPromises()
}

afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount()
  delete window.__STEPTRACK_TEST_DEVICE__
  document.body.innerHTML = ''
})

function nativeScanner(results: Array<ScanResult | null | Error>): ScannerAdapter & { calls: number } {
  const s = {
    kind: 'native' as const,
    calls: 0,
    isSupported: async () => true,
    scanOnce: vi.fn(async () => {
      const r = results[Math.min(s.calls++, results.length - 1)]!
      if (r instanceof Error) throw r
      return r
    }),
  }
  return s
}

describe('ScanButton — native scanner', () => {
  it('emits the scanned text once', async () => {
    inject({ scanner: nativeScanner([{ text: 'st:ws:WS-03', format: 'QR_CODE' }]) })
    const w = mountIt(ScanButton, { label: 'Scan station' })
    expect(w.text()).toContain('Scan station')
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    expect(w.emitted('scanned')).toEqual([['st:ws:WS-03']])
  })

  it('emits nothing when the operator cancels', async () => {
    inject({ scanner: nativeScanner([null]) })
    const w = mountIt(ScanButton)
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    expect(w.emitted('scanned')).toBeUndefined()
    expect(w.emitted('error')).toBeUndefined()
  })

  it('reports a denied permission as an i18n key', async () => {
    inject({ scanner: nativeScanner([new DeviceError('cameraDenied')]) })
    const w = mountIt(ScanButton)
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    expect(w.emitted('error')).toEqual([['st.device.errors.cameraDenied']])
  })

  it('reports an unsupported scanner', async () => {
    inject({ scanner: { kind: 'native', isSupported: async () => false, scanOnce: vi.fn() } })
    const w = mountIt(ScanButton)
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    expect(w.emitted('error')).toEqual([['st.device.errors.scannerUnsupported']])
  })

  it('unknown failures map to scanFailed', async () => {
    inject({ scanner: nativeScanner([new Error('kaputt')]) })
    const w = mountIt(ScanButton)
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    expect(w.emitted('error')).toEqual([['st.device.errors.scanFailed']])
  })

  it('a mismatch against expect is shown; rescan or use anyway', async () => {
    const scanner = nativeScanner([{ text: 'TW-999' }, { text: 'TW-998' }])
    inject({ scanner })
    const w = mountIt(ScanButton, { expect: '/^TW-0\\d\\d$/' })
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    expect(w.emitted('scanned')).toBeUndefined()
    expect($('[data-test=scan-mismatch-value]')?.textContent).toBe('TW-999')
    expect(document.body.textContent).toContain('Expected format: /^TW-0\\d\\d$/')

    await click('[data-test=scan-again]')
    expect(scanner.calls).toBe(2)
    expect($('[data-test=scan-mismatch-value]')?.textContent).toBe('TW-998')

    await click('[data-test=scan-use-anyway]')
    expect(w.emitted('scanned')).toEqual([['TW-998']])
    expect($('[data-test=scan-mismatch-value]')).toBeNull()
  })

  it('a matching scan passes straight through (whitespace from scanners tolerated)', async () => {
    inject({ scanner: nativeScanner([{ text: 'TW-017\r\n' }]) })
    const w = mountIt(ScanButton, { expect: 'TW-017' })
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    expect(w.emitted('scanned')).toEqual([['TW-017\r\n']])
  })

  it('does nothing while disabled', async () => {
    const scanner = nativeScanner([{ text: 'x' }])
    inject({ scanner })
    const w = mountIt(ScanButton, { disabled: true })
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    expect(scanner.calls).toBe(0)
  })

  it('forwards attributes to the button', async () => {
    inject({ scanner: nativeScanner([null]) })
    const w = mountIt(ScanButton)
    w.unmount()
    wrappers.pop()
    const w2 = mount(ScanButton, { attrs: { class: 'extra', 'data-x': '1' }, attachTo: document.body, global: { plugins: [i18n()] } })
    wrappers.push(w2)
    expect(w2.get('[data-test=scan-button]').classes()).toContain('extra')
    expect(w2.get('[data-test=scan-button]').attributes('data-x')).toBe('1')
  })
})

describe('ScanButton — web overlay', () => {
  function webScanner(results: Array<ScanResult | null>) {
    const seen: { video?: HTMLVideoElement; signal?: AbortSignal }[] = []
    let i = 0
    const pending: Array<(r: ScanResult | null) => void> = []
    const s: ScannerAdapter = {
      kind: 'web',
      isSupported: async () => true,
      scanOnce: (opts) => {
        seen.push(opts)
        const r = results[i++]
        if (r === undefined) return new Promise((res) => pending.push(res))
        return Promise.resolve(r)
      },
    }
    return { s, seen, pending }
  }

  it('renders a camera view into a <video> and emits the result', async () => {
    const { s, seen } = webScanner([{ text: 'st:run:0190f000-0000-7000-8000-000000000001' }])
    inject({ scanner: s })
    const w = mountIt(ScanButton)
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    expect(seen[0]!.video).toBeInstanceOf(HTMLVideoElement)
    expect(w.emitted('scanned')).toEqual([['st:run:0190f000-0000-7000-8000-000000000001']])
    expect($('[data-test=scanner-overlay]')).toBeNull()
  })

  it('cancel aborts the scan and closes the overlay', async () => {
    const { s, seen } = webScanner([])
    inject({ scanner: s })
    const w = mountIt(ScanButton)
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    const overlay = $('[data-test=scanner-overlay]')
    expect(overlay).not.toBeNull()
    expect(overlay!.closest('.st-root')).not.toBeNull()
    await click('[data-test=scan-cancel]')
    expect(seen[0]!.signal!.aborted).toBe(true)
    expect($('[data-test=scanner-overlay]')).toBeNull()
    expect(w.emitted('scanned')).toBeUndefined()
  })

  it('Escape cancels', async () => {
    const { s, seen } = webScanner([])
    inject({ scanner: s })
    const w = mountIt(ScanButton)
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(seen[0]!.signal!.aborted).toBe(true)
    expect($('[data-test=scanner-overlay]')).toBeNull()
  })

  it('shows a mismatch inside the overlay and can rescan', async () => {
    const { s, seen } = webScanner([{ text: 'PN-1' }, { text: 'TW-017' }])
    inject({ scanner: s })
    const w = mountIt(ScanButton, { expect: 'TW-017' })
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    expect($('[data-test=scan-mismatch]')?.textContent).toContain('PN-1')
    expect($('[data-test=scan-mismatch]')?.textContent).toContain('Expected: TW-017')
    await click('[data-test=scan-again]')
    expect(seen.length).toBe(2)
    expect(w.emitted('scanned')).toEqual([['TW-017']])
  })

  it('use anyway passes the mismatching text on', async () => {
    const { s } = webScanner([{ text: 'PN-1' }])
    inject({ scanner: s })
    const w = mountIt(ScanButton, { expect: 'TW-017' })
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    await click('[data-test=scan-use-anyway]')
    expect(w.emitted('scanned')).toEqual([['PN-1']])
  })

  it('camera errors close the overlay and are emitted', async () => {
    inject({ scanner: { kind: 'web', isSupported: async () => true, scanOnce: async () => Promise.reject(new DeviceError('noCamera')) } })
    const w = mountIt(ScanButton)
    await w.get('[data-test=scan-button]').trigger('click')
    await flushPromises()
    expect(w.emitted('error')).toEqual([['st.device.errors.noCamera']])
    expect($('[data-test=scanner-overlay]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------- OCR

function camera(results: Array<Blob | null | Error>): CameraAdapter & { calls: number } {
  const c = {
    kind: 'web' as const,
    calls: 0,
    capturePhoto: vi.fn(async () => {
      const r = results[Math.min(c.calls++, results.length - 1)]!
      if (r instanceof Error) throw r
      return r
    }),
  }
  return c
}

function ocr(result: OcrResult | Error, extra: Partial<{ isAvailable: () => Promise<boolean> }> = {}): OcrAdapter & { opts: unknown[] } {
  const o = {
    kind: 'web' as const,
    opts: [] as unknown[],
    recognizeNumber: vi.fn(async (_b: Blob, opts?: unknown) => {
      o.opts.push(opts)
      if (result instanceof Error) throw result
      return result
    }),
    ...extra,
  }
  return o
}

const photo = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' })
const READING: OcrResult = { raw: 'l2.5O Nm', value: '12.50', confidence: 0.77, candidates: ['12.50', '1250.00'] }

describe('OcrCaptureButton', () => {
  async function open(o: OcrAdapter, props: Record<string, unknown> = { decimals: 2, unit: 'Nm' }, cam = camera([photo()])) {
    inject({ camera: cam, ocr: o })
    const w = mountIt(OcrCaptureButton, props)
    await flushPromises()
    await w.get('[data-test=ocr-button]').trigger('click')
    await flushPromises()
    return w
  }
  const input = () => $('[data-test=ocr-value]') as HTMLInputElement
  const type = async (v: string) => {
    input().value = v
    input().dispatchEvent(new Event('input'))
    await flushPromises()
  }

  it('shows photo, value and candidates and never emits without confirmation', async () => {
    const o = ocr(READING)
    const w = await open(o)
    expect(o.opts[0]).toEqual({ decimals: 2, unit: 'Nm' })
    expect($('[data-test=ocr-photo]')).not.toBeNull()
    expect(input().value).toBe('12.50')
    expect($('[data-test=ocr-raw]')?.textContent).toBe('l2.5O Nm')
    expect($('[data-test="ocr-candidate-1250.00"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Confidence 77 %')
    expect(w.emitted('read')).toBeUndefined()

    await click('[data-test=ocr-confirm]')
    expect(w.emitted('read')).toEqual([[{ value: '12.50', raw: 'l2.5O Nm', confidence: 0.77 }]])
    expect($('[data-test=ocr-value]')).toBeNull()
  })

  it('picking another candidate uses it', async () => {
    const w = await open(ocr(READING))
    await click('[data-test="ocr-candidate-1250.00"]')
    expect(input().value).toBe('1250.00')
    expect($('[data-test=ocr-edited]')).toBeNull()
    await click('[data-test=ocr-confirm]')
    expect((w.emitted('read')![0]![0] as { value: string }).value).toBe('1250.00')
  })

  it('an edited value is allowed but flagged, and keeps the raw OCR text', async () => {
    const w = await open(ocr(READING))
    await type('12,58')
    expect($('[data-test=ocr-edited]')).not.toBeNull()
    await click('[data-test=ocr-confirm]')
    expect(w.emitted('read')).toEqual([[{ value: '12.58', raw: 'l2.5O Nm', confidence: 0.77 }]])
  })

  it('an equal value in another notation is not flagged as edited', async () => {
    await open(ocr(READING))
    await type('12.5')
    expect($('[data-test=ocr-edited]')).toBeNull()
  })

  it('pads to the expected decimals and refuses values that would need rounding', async () => {
    const w = await open(ocr(READING))
    await type('12.505')
    expect(($('[data-test=ocr-confirm]') as HTMLButtonElement).disabled).toBe(true)
    expect(document.body.textContent).toContain('At most 2 decimal places')
    await type('abc')
    expect(($('[data-test=ocr-confirm]') as HTMLButtonElement).disabled).toBe(true)
    await type('7')
    await click('[data-test=ocr-confirm]')
    expect((w.emitted('read')![0]![0] as { value: string }).value).toBe('7.00')
  })

  it('without a reading there is nothing to confirm', async () => {
    const w = await open(ocr({ raw: '---', value: null, confidence: 0, candidates: [] }))
    expect($('[data-test=ocr-none]')).not.toBeNull()
    expect($('[data-test=ocr-confirm]')).toBeNull()
    expect($('[data-test=ocr-value]')).toBeNull()
    await click('[data-test=ocr-cancel]')
    expect(w.emitted('read')).toBeUndefined()
  })

  it('OCR failure keeps the photo visible and emits nothing', async () => {
    const w = await open(ocr(new DeviceError('ocrUnavailable')))
    expect($('[data-test=ocr-failed]')?.textContent).toContain('not available')
    expect($('[data-test=ocr-photo]')).not.toBeNull()
    expect(w.emitted('read')).toBeUndefined()
  })

  it('explains when OCR is unavailable and disables the button', async () => {
    const o = ocr(READING, { isAvailable: async () => false })
    inject({ camera: camera([photo()]), ocr: o })
    const w = mountIt(OcrCaptureButton, { decimals: 2 })
    await flushPromises()
    expect(w.get('[data-test=ocr-button]').attributes('disabled')).toBeDefined()
    expect(w.get('[data-test=ocr-unavailable]').text()).toContain('Type the value in manually')
  })

  it('a cancelled photo opens nothing', async () => {
    const o = ocr(READING)
    const w = await open(o, { decimals: 2 }, camera([null]))
    expect(o.recognizeNumber).not.toHaveBeenCalled()
    expect($('[data-test=ocr-photo]')).toBeNull()
    expect(w.emitted('read')).toBeUndefined()
  })

  it('camera errors are emitted', async () => {
    const w = await open(ocr(READING), { decimals: 2 }, camera([new DeviceError('cameraDenied')]))
    expect(w.emitted('error')).toEqual([['st.device.errors.cameraDenied']])
  })

  it('retake runs OCR on the new photo', async () => {
    const o = ocr(READING)
    const cam = camera([photo(), photo()])
    await open(o, { decimals: 2 }, cam)
    await click('[data-test=ocr-retake]')
    expect(cam.calls).toBe(2)
    expect(o.recognizeNumber).toHaveBeenCalledTimes(2)
  })

  it('a review in progress cannot be dismissed by tapping the backdrop', async () => {
    await open(ocr(READING))
    await click('.st-dialog-backdrop')
    expect($('[data-test=ocr-value]')).not.toBeNull()
  })
})

describe('PhotoCaptureButton', () => {
  it('emits the captured blob', async () => {
    const b = photo()
    inject({ camera: camera([b]) })
    const w = mountIt(PhotoCaptureButton, { label: 'Take photo' })
    expect(w.text()).toContain('Take photo')
    await w.get('[data-test=photo-button]').trigger('click')
    await flushPromises()
    expect(w.emitted('captured')![0]![0]).toBe(b)
  })

  it('cancel emits nothing; errors are emitted as keys', async () => {
    inject({ camera: camera([null, new DeviceError('imageUnreadable')]) })
    const w = mountIt(PhotoCaptureButton)
    await w.get('[data-test=photo-button]').trigger('click')
    await flushPromises()
    expect(w.emitted('captured')).toBeUndefined()
    await w.get('[data-test=photo-button]').trigger('click')
    await flushPromises()
    expect(w.emitted('error')).toEqual([['st.device.errors.imageUnreadable']])
  })

  it('calls the camera synchronously from the click (user activation for the file picker)', async () => {
    const cam = camera([photo()])
    inject({ camera: cam })
    const w = mountIt(PhotoCaptureButton)
    ;(w.get('[data-test=photo-button]').element as HTMLButtonElement).click()
    expect(cam.capturePhoto).toHaveBeenCalledTimes(1)
    await flushPromises()
  })
})

describe('device i18n', () => {
  function keys(o: Record<string, unknown>, p = ''): string[] {
    return Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]))
  }
  const en = new Set(keys((messages.en as { st: Record<string, unknown> }).st, 'st.'))
  const de = new Set(keys((messages.de as { st: Record<string, unknown> }).st, 'st.'))

  it('en and de define the same device keys', () => {
    const enDevice = [...en].filter((k) => k.startsWith('st.device.'))
    const deDevice = [...de].filter((k) => k.startsWith('st.device.'))
    expect(enDevice.length).toBeGreaterThan(30)
    expect(new Set(enDevice)).toEqual(new Set(deDevice))
  })

  it('every st.device key used in source exists in both locales', () => {
    const roots = [join(__dirname), join(__dirname, '../../device')]
    const used = new Set<string>()
    const walk = (dir: string) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, f.name)
        if (f.isDirectory()) walk(p)
        else if (/\.(vue|ts)$/.test(f.name) && !f.name.endsWith('.test.ts')) {
          for (const m of readFileSync(p, 'utf8').matchAll(/['"`](st\.device\.[\w.]+)['"`]/g)) used.add(m[1]!)
        }
      }
    }
    roots.forEach(walk)
    const src = readFileSync(join(__dirname, '../../device/errors.ts'), 'utf8')
    const codes = /DeviceErrorCode =([\s\S]*?)\n\n/.exec(src)![1]!.match(/'(\w+)'/g)!.map((c) => `st.device.errors.${c.slice(1, -1)}`)
    codes.forEach((c) => used.add(c))
    expect(used.size).toBeGreaterThan(20)
    for (const k of used) {
      expect(en.has(k), `en ${k}`).toBe(true)
      expect(de.has(k), `de ${k}`).toBe(true)
    }
  })
})
