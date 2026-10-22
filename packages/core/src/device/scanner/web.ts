// Web scanner: camera stream into the caller's <video>, decoded by BarcodeDetector where it can read QR
// codes, else by ZXing (loaded on demand). The stream stays attached to the <video> while scanning so the
// overlay can drive the torch through video.srcObject.
import type { ScannerAdapter, ScanResult } from '../types'
import { DeviceError, mediaError } from '../errors'
import { detectorFormatsToUse, selectScannerEngine, type ScannerEngine, type ScannerEnv } from './select'

interface DetectedBarcode {
  rawValue: string
  format: string
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats?(): Promise<string[]>
}

const FRAME_INTERVAL_MS = 120
/** BarcodeDetector failing this many frames in a row is broken, not just "no code in view" */
const MAX_CONSECUTIVE_ERRORS = 25

function detectorCtor(): BarcodeDetectorCtor | null {
  const c = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  return typeof c === 'function' ? c : null
}

export async function probeScannerEnv(): Promise<ScannerEnv> {
  const ctor = detectorCtor()
  let formats: string[] = []
  if (ctor?.getSupportedFormats) {
    try {
      formats = await ctor.getSupportedFormats()
    } catch {
      formats = []
    }
  }
  return { native: false, hasBarcodeDetector: !!ctor, detectorFormats: formats }
}

export function cameraConstraints(): MediaStreamConstraints {
  return {
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  }
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop())
}

function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (!signal) return () => {}
  signal.addEventListener('abort', fn, { once: true })
  return () => signal.removeEventListener('abort', fn)
}

function detectorLoop(video: HTMLVideoElement, formats: string[], signal?: AbortSignal): Promise<ScanResult | null> {
  const Ctor = detectorCtor()!
  const detector = new Ctor({ formats })
  return new Promise((resolve, reject) => {
    let done = false
    let errors = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      off()
      fn()
    }
    const off = onAbort(signal, () => finish(() => resolve(null)))
    const tick = async () => {
      if (done) return
      try {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          const codes = await detector.detect(video)
          errors = 0
          const hit = codes.find((c) => c.rawValue)
          if (hit) return finish(() => resolve({ text: hit.rawValue, format: hit.format }))
        }
      } catch (e) {
        if (++errors >= MAX_CONSECUTIVE_ERRORS) return finish(() => reject(new DeviceError('scanFailed', e)))
      }
      if (!done) timer = setTimeout(tick, FRAME_INTERVAL_MS)
    }
    void tick()
  })
}

async function zxingLoop(video: HTMLVideoElement, signal?: AbortSignal): Promise<ScanResult | null> {
  const { BrowserMultiFormatReader, BarcodeFormat } = await import('@zxing/browser')
  if (signal?.aborted) return null
  const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: FRAME_INTERVAL_MS, delayBetweenScanSuccess: 500 })
  return new Promise((resolve, reject) => {
    let done = false
    let controls: { stop: () => void } | null = null
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      controls?.stop()
      off()
      fn()
    }
    const off = onAbort(signal, () => finish(() => resolve(null)))
    reader
      .decodeFromVideoElement(video, (result) => {
        if (!result) return
        const text = result.getText()
        if (text) finish(() => resolve({ text, format: String(BarcodeFormat[result.getBarcodeFormat()] ?? '') }))
      })
      .then(
        (c) => {
          controls = c
          if (done) c.stop()
        },
        (e) => finish(() => reject(mediaError(e, 'scanFailed'))),
      )
  })
}

export interface WebScannerAdapter extends ScannerAdapter {
  readonly kind: 'web'
  engine(): Promise<ScannerEngine>
}

export function createWebScanner(): WebScannerAdapter {
  let engine: Promise<ScannerEngine> | null = null
  let env: ScannerEnv | null = null
  const resolveEngine = () =>
    (engine ??= probeScannerEnv().then((e) => {
      env = e
      return selectScannerEngine(e)
    }))

  return {
    kind: 'web',
    engine: resolveEngine,
    async isSupported() {
      return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
    },
    async scanOnce({ video, signal }) {
      if (signal?.aborted) return null
      if (!video) throw new DeviceError('noPreview')
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DeviceError(typeof window !== 'undefined' && window.isSecureContext === false ? 'insecureContext' : 'noCamera')
      }
      let stream: MediaStream | null = null
      try {
        stream = await navigator.mediaDevices.getUserMedia(cameraConstraints())
      } catch (e) {
        throw mediaError(e)
      }
      if (signal?.aborted) {
        stopStream(stream)
        return null
      }
      try {
        video.muted = true
        video.setAttribute('playsinline', '')
        video.srcObject = stream
        // muted inline video may autoplay; if not, ZXing retries on canplay and BarcodeDetector waits for frames
        await video.play().catch(() => undefined)
        const which = await resolveEngine()
        return which === 'barcode-detector'
          ? await detectorLoop(video, detectorFormatsToUse(env?.detectorFormats ?? []), signal)
          : await zxingLoop(video, signal)
      } finally {
        stopStream(stream)
        if (video.srcObject === stream) video.srcObject = null
      }
    },
  }
}
