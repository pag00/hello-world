// Device adapters: platform defaults (Capacitor native vs. web), host overrides via config.device, and
// window.__STEPTRACK_TEST_DEVICE__ for e2e tests that need a fake scanner/OCR/camera.
import { getCurrentInstance } from 'vue'
import type { DeviceAdapters, OcrAdapter } from './types'
import { getStepTrackConfig, useStepTrackConfig } from '../config'
import { isNativePlatform } from './platform'
import { createWebScanner } from './scanner/web'
import { createNativeScanner } from './scanner/native'
import { createWebCamera } from './camera/web'
import { createNativeCamera } from './camera/native'
import { createTesseractOcr } from './ocr/web'
import { createNativeOcr } from './ocr/native'

export * from './types'
export { DeviceError, errorMessage, isCancellation, type DeviceErrorCode } from './errors'
export { fitWithin, compressImage, MAX_EDGE, JPEG_QUALITY } from './image'
export { parseOcrNumber, extractCandidates, stripUnits, type ParseOptions, type OcrCandidate } from './ocr/parse'
export { createTesseractOcr, defaultTesseractBase, OCR_WHITELIST, type TesseractOcrAdapter, type TesseractOcrOptions } from './ocr/web'
export { createNativeOcr } from './ocr/native'
export { createWebScanner, type WebScannerAdapter } from './scanner/web'
export { createNativeScanner, openNativeSettings } from './scanner/native'
export { selectScannerEngine, WANTED_FORMATS, type ScannerEngine, type ScannerEnv } from './scanner/select'
export { createWebCamera, pickImageFile } from './camera/web'
export { createNativeCamera } from './camera/native'
export { describeExpect, checkExpect, type ExpectHint, type ExpectCheck } from './expect'
export { isNativePlatform, platformName } from './platform'

declare global {
  interface Window {
    /** e2e hook: adapters given here win over config and platform defaults */
    __STEPTRACK_TEST_DEVICE__?: Partial<DeviceAdapters>
  }
}

let defaults: DeviceAdapters | null = null

/** Platform default adapters, created once so the OCR worker and scanner probes are shared. */
export function platformDevice(): DeviceAdapters {
  if (defaults) return defaults
  const tesseract = createTesseractOcr()
  defaults = isNativePlatform()
    ? { scanner: createNativeScanner(), ocr: createNativeOcr(tesseract), camera: createNativeCamera() }
    : { scanner: createWebScanner(), ocr: tesseract, camera: createWebCamera() }
  return defaults
}

/** Test hook: forget the cached platform adapters. */
export function resetPlatformDevice(): void {
  defaults = null
}

function configured(): Partial<DeviceAdapters> {
  try {
    return (getCurrentInstance() ? useStepTrackConfig() : getStepTrackConfig()).device ?? {}
  } catch {
    // not installed (unit tests rendering a component in isolation): platform defaults only
    return {}
  }
}

export function useDevice(): DeviceAdapters {
  const cfg = configured()
  const test = (typeof window !== 'undefined' && window.__STEPTRACK_TEST_DEVICE__) || {}
  const d = () => platformDevice()
  return {
    scanner: test.scanner ?? cfg.scanner ?? d().scanner,
    ocr: test.ocr ?? cfg.ocr ?? d().ocr,
    camera: test.camera ?? cfg.camera ?? d().camera,
  }
}

/** Adapters may expose isAvailable() (an extension of the contract); assume available otherwise. */
export async function ocrAvailable(ocr: OcrAdapter): Promise<boolean> {
  const probe = (ocr as Partial<{ isAvailable: () => Promise<boolean> }>).isAvailable
  if (typeof probe !== 'function') return true
  try {
    return await probe.call(ocr)
  } catch {
    return false
  }
}
