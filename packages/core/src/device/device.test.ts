import { afterEach, describe, expect, it, vi } from 'vitest'
import { fitWithin, MAX_EDGE } from './image'
import { detectorFormatsToUse, selectScannerEngine, WANTED_FORMATS } from './scanner/select'
import { checkExpect, describeExpect } from './expect'
import { DeviceError, errorMessage, isCancellation, mediaError } from './errors'
import { probeScannerEnv } from './scanner/web'
import { ocrAvailable, resetPlatformDevice, useDevice } from './index'
import type { DeviceAdapters } from './types'

describe('fitWithin (photo resize math)', () => {
  it('keeps images that already fit', () => {
    expect(fitWithin(1600, 1200)).toEqual({ width: 1600, height: 1200 })
    expect(fitWithin(2048, 1536)).toEqual({ width: 2048, height: 1536 })
    expect(fitWithin(1, 1)).toEqual({ width: 1, height: 1 })
  })

  it('never upscales', () => {
    expect(fitWithin(320, 240)).toEqual({ width: 320, height: 240 })
  })

  it('scales landscape so the long edge is exactly the max', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 2048, height: 1536 })
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 })
  })

  it('scales portrait', () => {
    expect(fitWithin(3000, 4000)).toEqual({ width: 1536, height: 2048 })
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: 2048 })
  })

  it('squares', () => {
    expect(fitWithin(5000, 5000)).toEqual({ width: 2048, height: 2048 })
  })

  it('rounds the short edge and never exceeds the max through rounding', () => {
    const r = fitWithin(4099, 2049)
    expect(r.width).toBe(2048)
    expect(r.height).toBe(Math.round(2049 * (2048 / 4099)))
    for (const [w, h] of [[2049, 2049], [8191, 3], [3, 8191], [4097, 4095]] as const) {
      const f = fitWithin(w, h)
      expect(Math.max(f.width, f.height)).toBeLessThanOrEqual(MAX_EDGE)
      expect(Math.min(f.width, f.height)).toBeGreaterThanOrEqual(1)
    }
  })

  it('extreme panoramas keep at least one pixel', () => {
    expect(fitWithin(100000, 10)).toEqual({ width: 2048, height: 1 })
  })

  it('honours a custom max edge', () => {
    expect(fitWithin(1000, 500, 100)).toEqual({ width: 100, height: 50 })
  })

  it('rejects nonsense sizes', () => {
    expect(() => fitWithin(0, 100)).toThrow()
    expect(() => fitWithin(100, -1)).toThrow()
    expect(() => fitWithin(Number.NaN, 100)).toThrow()
    expect(() => fitWithin(Number.POSITIVE_INFINITY, 100)).toThrow()
  })
})

describe('selectScannerEngine', () => {
  it('uses ML Kit on native regardless of web APIs', () => {
    expect(selectScannerEngine({ native: true, hasBarcodeDetector: true, detectorFormats: ['qr_code'] })).toBe('native')
    expect(selectScannerEngine({ native: true, hasBarcodeDetector: false, detectorFormats: [] })).toBe('native')
  })

  it('uses BarcodeDetector when it can read QR codes', () => {
    expect(selectScannerEngine({ native: false, hasBarcodeDetector: true, detectorFormats: ['qr_code', 'code_128'] })).toBe('barcode-detector')
  })

  it('falls back to ZXing when BarcodeDetector is missing, empty or lacks QR', () => {
    expect(selectScannerEngine({ native: false, hasBarcodeDetector: false, detectorFormats: [] })).toBe('zxing')
    expect(selectScannerEngine({ native: false, hasBarcodeDetector: true, detectorFormats: [] })).toBe('zxing')
    expect(selectScannerEngine({ native: false, hasBarcodeDetector: true, detectorFormats: ['ean_13', 'code_128'] })).toBe('zxing')
  })

  it('requests only wanted formats the detector supports', () => {
    expect(detectorFormatsToUse(['qr_code', 'ean_13', 'unknown_fmt'])).toEqual(['qr_code', 'ean_13'])
    expect(detectorFormatsToUse([...WANTED_FORMATS])).toEqual([...WANTED_FORMATS])
  })
})

describe('probeScannerEnv', () => {
  afterEach(() => {
    delete (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector
  })

  it('reports a missing BarcodeDetector', async () => {
    expect(await probeScannerEnv()).toEqual({ native: false, hasBarcodeDetector: false, detectorFormats: [] })
  })

  it('reads supported formats', async () => {
    ;(globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = Object.assign(function () {}, {
      getSupportedFormats: async () => ['qr_code', 'data_matrix'],
    })
    expect(await probeScannerEnv()).toEqual({ native: false, hasBarcodeDetector: true, detectorFormats: ['qr_code', 'data_matrix'] })
  })

  it('treats a throwing getSupportedFormats as no formats', async () => {
    ;(globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = Object.assign(function () {}, {
      getSupportedFormats: async () => {
        throw new Error('boom')
      },
    })
    const env = await probeScannerEnv()
    expect(env.detectorFormats).toEqual([])
    expect(selectScannerEngine(env)).toBe('zxing')
  })
})

describe('expect hint helper', () => {
  it('describes the expectation', () => {
    expect(describeExpect(null)).toEqual({ kind: 'none' })
    expect(describeExpect(undefined)).toEqual({ kind: 'none' })
    expect(describeExpect('')).toEqual({ kind: 'none' })
    expect(describeExpect('TW-017')).toEqual({ kind: 'exact', value: 'TW-017' })
    expect(describeExpect('/^TW-\\d{3}$/')).toEqual({ kind: 'pattern', pattern: '/^TW-\\d{3}$/', valid: true })
    expect(describeExpect('/^PN-/i')).toEqual({ kind: 'pattern', pattern: '/^PN-/i', valid: true })
    expect(describeExpect('/([/')).toEqual({ kind: 'pattern', pattern: '/([/', valid: false })
  })

  it('a lone slash or slashes inside a value are exact values', () => {
    expect(describeExpect('/')).toEqual({ kind: 'exact', value: '/' })
    expect(describeExpect('A/B')).toEqual({ kind: 'exact', value: 'A/B' })
  })

  it('checks scanned text the same way the run fields do', () => {
    expect(checkExpect('anything', null)).toBe('none')
    expect(checkExpect('TW-017', 'TW-017')).toBe('match')
    expect(checkExpect('  TW-017\n', 'TW-017')).toBe('match') // scanners append CR/LF
    expect(checkExpect('tw-017', 'TW-017')).toBe('mismatch') // exact is case-sensitive
    expect(checkExpect('TW-017', '/^TW-\\d{3}$/')).toBe('match')
    expect(checkExpect('TW-17', '/^TW-\\d{3}$/')).toBe('mismatch')
    expect(checkExpect('pn-42', '/^PN-/i')).toBe('match')
    expect(checkExpect('X', '/([/')).toBe('mismatch') // invalid pattern never matches
  })

  it('stateful regex flags do not make repeated checks flip', () => {
    expect(checkExpect('TW-1', '/TW/g')).toBe('match')
    expect(checkExpect('TW-1', '/TW/g')).toBe('match')
  })
})

describe('device errors', () => {
  it('maps DOMException names', () => {
    expect(mediaError({ name: 'NotAllowedError' }).code).toBe('cameraDenied')
    expect(mediaError({ name: 'NotFoundError' }).code).toBe('noCamera')
    expect(mediaError({ name: 'NotReadableError' }).code).toBe('cameraBusy')
    expect(mediaError({ name: 'Weird' }).code).toBe('cameraFailed')
    expect(mediaError(new DeviceError('noPreview')).code).toBe('noPreview')
  })

  it('messages are i18n keys', () => {
    expect(new DeviceError('cameraDenied').message).toBe('st.device.errors.cameraDenied')
    expect(errorMessage(new Error('x'), 'scanFailed')).toBe('st.device.errors.scanFailed')
  })

  it('recognises plugin cancellations', () => {
    expect(isCancellation(new Error('scan canceled.'))).toBe(true)
    expect(isCancellation(new Error('User cancelled photos app'))).toBe(true)
    expect(isCancellation(new Error('No image picked'))).toBe(true)
    expect(isCancellation(new Error('User denied access to camera.'))).toBe(false)
  })
})

describe('useDevice', () => {
  afterEach(() => {
    delete window.__STEPTRACK_TEST_DEVICE__
    resetPlatformDevice()
  })

  it('returns web adapters in a browser', () => {
    const d = useDevice()
    expect(d.scanner.kind).toBe('web')
    expect(d.ocr.kind).toBe('web')
    expect(d.camera.kind).toBe('web')
    // shared instances, so the OCR worker is reused
    expect(useDevice().ocr).toBe(d.ocr)
  })

  it('honours window.__STEPTRACK_TEST_DEVICE__ per adapter', () => {
    const fake: Partial<DeviceAdapters> = {
      scanner: { kind: 'native', isSupported: async () => true, scanOnce: async () => ({ text: 'st:ws:WS-01' }) },
    }
    window.__STEPTRACK_TEST_DEVICE__ = fake
    const d = useDevice()
    expect(d.scanner).toBe(fake.scanner)
    expect(d.camera.kind).toBe('web')
  })

  it('ocrAvailable uses isAvailable when the adapter has it', async () => {
    const plain = { kind: 'web' as const, recognizeNumber: vi.fn() }
    expect(await ocrAvailable(plain)).toBe(true)
    expect(await ocrAvailable({ ...plain, isAvailable: async () => false } as never)).toBe(false)
    expect(await ocrAvailable({ ...plain, isAvailable: async () => Promise.reject(new Error('x')) } as never)).toBe(false)
  })
})
