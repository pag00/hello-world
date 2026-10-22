// Which scanning engine to use. Kept pure so the decision is testable without a camera.

export type ScannerEngine = 'native' | 'barcode-detector' | 'zxing'

/** BarcodeDetector format names we ask for: QR plus the common 1D/2D symbologies on parts and tools. */
export const WANTED_FORMATS = [
  'qr_code',
  'data_matrix',
  'aztec',
  'pdf417',
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'itf',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
] as const

export interface ScannerEnv {
  native: boolean
  /** `BarcodeDetector` exists on globalThis */
  hasBarcodeDetector: boolean
  /** result of BarcodeDetector.getSupportedFormats(); [] when unknown or it threw */
  detectorFormats: readonly string[]
}

/**
 * Native → ML Kit. Web → BarcodeDetector only if it can read QR codes (desktop Chrome on Linux ships the
 * API with an empty format list), otherwise the ZXing fallback, which works everywhere with a camera.
 */
export function selectScannerEngine(env: ScannerEnv): ScannerEngine {
  if (env.native) return 'native'
  if (env.hasBarcodeDetector && env.detectorFormats.includes('qr_code')) return 'barcode-detector'
  return 'zxing'
}

/** Formats to request from BarcodeDetector: the wanted ones it actually supports. */
export function detectorFormatsToUse(supported: readonly string[]): string[] {
  return WANTED_FORMATS.filter((f) => supported.includes(f))
}
