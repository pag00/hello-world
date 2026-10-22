import type { DecimalString } from '../domain/types'

export interface ScanResult {
  text: string
  format?: string
}

/** One-shot barcode/QR scan. Implementations: Capacitor ML Kit (native), BarcodeDetector/ZXing (web). */
export interface ScannerAdapter {
  readonly kind: 'native' | 'web'
  isSupported(): Promise<boolean>
  /**
   * Web adapters render into the provided <video> element; native adapters ignore it
   * and show the system scanner UI. Resolves null when cancelled via signal.
   */
  scanOnce(opts: { video?: HTMLVideoElement; signal?: AbortSignal }): Promise<ScanResult | null>
}

export interface OcrResult {
  /** raw recognised text */
  raw: string
  /** best numeric candidate normalised to a decimal string, or null */
  value: DecimalString | null
  /** 0..1 */
  confidence: number
  candidates: DecimalString[]
}

/** Numeric OCR from a photo of a display/gauge. Implementations: ML Kit text recognition, tesseract.js. */
export interface OcrAdapter {
  readonly kind: 'native' | 'web'
  recognizeNumber(image: Blob, opts?: { decimals?: number }): Promise<OcrResult>
}

/** Photo capture → compressed JPEG (long edge ≤ 2048 px, quality ~0.8). */
export interface CameraAdapter {
  readonly kind: 'native' | 'web'
  capturePhoto(): Promise<Blob | null>
}

export interface DeviceAdapters {
  scanner: ScannerAdapter
  ocr: OcrAdapter
  camera: CameraAdapter
}
