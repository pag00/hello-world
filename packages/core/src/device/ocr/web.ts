// Web OCR: tesseract.js v7 with every asset served by the app itself (worker, LSTM core, eng traineddata)
// so it works offline once the PWA has cached them. apps/web/scripts/copy-ocr-assets.mjs lays them out:
//   <base>/worker.min.js, <base>/core/tesseract-core{,-simd}-lstm.wasm.js, <base>/lang/eng.traineddata.gz,
//   <base>/manifest.json  ({ "lang": ["eng"], ... } — tells us whether the traineddata is present)
import type { OcrAdapter, OcrResult } from '../types'
import { DeviceError } from '../errors'
import { parseOcrNumber, type ParseOptions } from './parse'

export const OCR_WHITELIST = '0123456789.,-'
/** Tesseract page segmentation modes (string enum in tesseract.js) */
const PSM_SINGLE_LINE = '7'
const PSM_SINGLE_BLOCK = '6'
const OEM_LSTM_ONLY = 1
/** free the ~40 MB worker when the operator is not measuring */
const IDLE_TERMINATE_MS = 120_000

export interface TesseractOcrOptions {
  /** URL (absolute or relative to the document) of the asset folder; default `${BASE_URL}tesseract/` */
  assetBase?: string
  lang?: string
}

export interface TesseractOcrAdapter extends OcrAdapter {
  readonly kind: 'web'
  /** false when the language data is missing (not downloaded at build time) or the assets are unreachable */
  isAvailable(): Promise<boolean>
  dispose(): Promise<void>
}

interface TesseractWorker {
  setParameters(p: Record<string, string>): Promise<unknown>
  recognize(image: Blob): Promise<{ data: { text: string; confidence: number } }>
  terminate(): Promise<unknown>
}

export function defaultTesseractBase(): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/'
  return `${base.replace(/\/?$/, '/')}tesseract/`
}

function absolute(path: string): string {
  const baseUri = typeof document !== 'undefined' ? document.baseURI : globalThis.location?.href
  return baseUri ? new URL(path, baseUri).href : path
}

/** Same probe as wasm-feature-detect's simd(): a module using v128 instructions validates only with SIMD. */
export function hasWasmSimd(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    )
  } catch {
    return false
  }
}

export function createTesseractOcr(opts: TesseractOcrOptions = {}): TesseractOcrAdapter {
  const base = (opts.assetBase ?? defaultTesseractBase()).replace(/\/?$/, '/')
  const lang = opts.lang ?? 'eng'
  let available: Promise<boolean> | null = null
  let worker: Promise<TesseractWorker> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let queue: Promise<unknown> = Promise.resolve()

  const isAvailable = () =>
    (available ??= fetch(absolute(`${base}manifest.json`), { cache: 'no-cache' })
      .then(async (r) => {
        if (!r.ok) return false
        const m = (await r.json()) as { lang?: string[] }
        return Array.isArray(m.lang) && m.lang.includes(lang)
      })
      .catch(() => false)
      .then((ok) => {
        // retry later (e.g. first load while offline before the SW had cached the manifest)
        if (!ok) available = null
        return ok
      }))

  async function spawn(): Promise<TesseractWorker> {
    const mod = (await import('tesseract.js')) as unknown as {
      createWorker?: (...a: unknown[]) => Promise<TesseractWorker>
      default?: { createWorker: (...a: unknown[]) => Promise<TesseractWorker> }
    }
    const createWorker = mod.createWorker ?? mod.default?.createWorker
    if (!createWorker) throw new DeviceError('ocrUnavailable', 'tesseract.js not loadable')
    const core = hasWasmSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'
    return createWorker(lang, OEM_LSTM_ONLY, {
      workerPath: absolute(`${base}worker.min.js`),
      corePath: absolute(`${base}core/${core}`),
      langPath: absolute(`${base}lang`),
      // a real same-origin worker URL, so the service worker can serve it offline
      workerBlobURL: false,
      gzip: true,
      // the PWA precache already holds the traineddata; don't keep a second copy in IndexedDB
      cacheMethod: 'none',
      logger: () => {},
    })
  }

  function getWorker(): Promise<TesseractWorker> {
    if (!worker) {
      worker = spawn()
      worker.catch(() => (worker = null))
    }
    return worker
  }

  function scheduleIdle() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => void dispose(), IDLE_TERMINATE_MS)
  }

  async function dispose() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    const w = worker
    worker = null
    if (w) await (await w.catch(() => null))?.terminate()
  }

  async function run(image: Blob, opts: ParseOptions = {}): Promise<OcrResult> {
    if (!(await isAvailable())) throw new DeviceError('ocrUnavailable')
    let w: TesseractWorker
    try {
      w = await getWorker()
    } catch (e) {
      throw new DeviceError('ocrUnavailable', e)
    }
    try {
      // a display reading is usually one line; fall back to block mode for multi-line panels
      let best: OcrResult | null = null
      for (const psm of [PSM_SINGLE_LINE, PSM_SINGLE_BLOCK]) {
        await w.setParameters({ tessedit_char_whitelist: OCR_WHITELIST, tessedit_pageseg_mode: psm })
        const { data } = await w.recognize(image)
        const r = parseOcrNumber(data.text.trim(), opts, data.confidence / 100)
        if (!best || (best.value === null && r.value !== null) || (r.value !== null && r.confidence > best.confidence)) best = r
        if (best.value !== null && best.confidence >= 0.6) break
      }
      return best!
    } catch (e) {
      throw new DeviceError('ocrFailed', e)
    } finally {
      scheduleIdle()
    }
  }

  return {
    kind: 'web',
    isAvailable,
    dispose,
    // `unit` is an extension of the OcrAdapter contract: callers that know it get better unit stripping
    recognizeNumber(image: Blob, o?: ParseOptions) {
      // one worker, one job at a time
      const job = queue.then(() => run(image, o))
      queue = job.catch(() => undefined)
      return job
    },
  }
}
