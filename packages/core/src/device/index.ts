// placeholder — device workstream implements platform detection + adapters
import type { DeviceAdapters } from './types'
import { getStepTrackConfig } from '../config'

export * from './types'

export function useDevice(): DeviceAdapters {
  const overrides = getStepTrackConfig().device ?? {}
  const missing = (n: string) => () => Promise.reject(new Error(`device.${n} not implemented`))
  return {
    scanner: overrides.scanner ?? { kind: 'web', isSupported: async () => false, scanOnce: missing('scanner') },
    ocr: overrides.ocr ?? { kind: 'web', recognizeNumber: missing('ocr') },
    camera: overrides.camera ?? { kind: 'web', capturePhoto: missing('camera') },
  }
}
