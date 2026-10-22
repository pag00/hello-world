// Native OCR: ML Kit text recognition (on-device, offline). ML Kit reads files, not Blobs, so it needs the
// original capture URI recorded by the native camera adapter; anything else (e.g. a photo from another
// source) goes to the bundled tesseract fallback.
import type { OcrAdapter } from '../types'
import { DeviceError } from '../errors'
import { nativeSourceOf } from '../camera/native'
import { parseOcrNumber, type ParseOptions } from './parse'
import type { TesseractOcrAdapter } from './web'

/** ML Kit reports no confidence; treat its text as fairly but not fully trusted. */
const MLKIT_NOMINAL_CONFIDENCE = 0.8

export interface NativeOcrAdapter extends OcrAdapter {
  readonly kind: 'native'
  isAvailable(): Promise<boolean>
}

export function createNativeOcr(fallback: TesseractOcrAdapter): NativeOcrAdapter {
  return {
    kind: 'native',
    // ML Kit's Latin model ships with the app; the fallback only matters for foreign blobs
    isAvailable: async () => true,
    async recognizeNumber(image: Blob, opts?: ParseOptions) {
      const path = nativeSourceOf(image)
      if (!path) return fallback.recognizeNumber(image, opts)
      let text: string
      try {
        const { TextRecognition } = await import('@capacitor-mlkit/text-recognition')
        text = (await TextRecognition.processImage({ path })).text
      } catch (e) {
        throw new DeviceError('ocrFailed', e)
      }
      return parseOcrNumber(text.trim(), opts ?? {}, MLKIT_NOMINAL_CONFIDENCE)
    },
  }
}
