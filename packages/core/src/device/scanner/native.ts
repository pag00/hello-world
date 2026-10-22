// Native scanner: Google code scanner via @capacitor-mlkit/barcode-scanning (system UI, no WebView preview).
// The plugin is imported on first use so web bundles never evaluate it.
import type { ScannerAdapter } from '../types'
import { DeviceError, isCancellation } from '../errors'
import { platformName } from '../platform'

type Plugin = typeof import('@capacitor-mlkit/barcode-scanning')

const MODULE_INSTALL_TIMEOUT_MS = 180_000

let pluginPromise: Promise<Plugin> | null = null
function plugin(): Promise<Plugin> {
  return (pluginPromise ??= import('@capacitor-mlkit/barcode-scanning'))
}

async function ensureCameraPermission(p: Plugin): Promise<void> {
  const { BarcodeScanner } = p
  let status = await BarcodeScanner.checkPermissions()
  if (status.camera === 'granted' || status.camera === 'limited') return
  status = await BarcodeScanner.requestPermissions()
  if (status.camera !== 'granted' && status.camera !== 'limited') throw new DeviceError('cameraDenied')
}

/** The Google code scanner is a Play Services module that may need a one-time download (needs a connection). */
async function ensureGoogleModule(p: Plugin, onProgress?: (percent: number | null) => void): Promise<void> {
  const { BarcodeScanner, GoogleBarcodeScannerModuleInstallState: S } = p
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()
  if (available) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new DeviceError('scannerModuleUnavailable')
  onProgress?.(null)
  await new Promise<void>((resolve, reject) => {
    let handle: { remove: () => Promise<void> } | null = null
    const timer = setTimeout(() => done(() => reject(new DeviceError('scannerModuleFailed', 'timeout'))), MODULE_INSTALL_TIMEOUT_MS)
    let finished = false
    const done = (fn: () => void) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      void handle?.remove()
      fn()
    }
    BarcodeScanner.addListener('googleBarcodeScannerModuleInstallProgress', (ev) => {
      if (ev.progress != null) onProgress?.(ev.progress)
      if (ev.state === S.COMPLETED) done(resolve)
      else if (ev.state === S.FAILED || ev.state === S.CANCELED) done(() => reject(new DeviceError('scannerModuleFailed', ev.state)))
    })
      .then((h) => {
        handle = h
        if (finished) void h.remove()
        return BarcodeScanner.installGoogleBarcodeScannerModule()
      })
      .catch((e: unknown) => {
        // "already installed" races are success
        if (/already installed/i.test(String((e as Error)?.message ?? e))) done(resolve)
        else done(() => reject(new DeviceError('scannerModuleFailed', e)))
      })
  })
}

export function createNativeScanner(): ScannerAdapter {
  return {
    kind: 'native',
    async isSupported() {
      try {
        const { BarcodeScanner } = await plugin()
        return (await BarcodeScanner.isSupported()).supported
      } catch {
        return false
      }
    },
    async scanOnce({ signal }) {
      if (signal?.aborted) return null
      const p = await plugin()
      await ensureCameraPermission(p)
      if (platformName() === 'android') await ensureGoogleModule(p)
      if (signal?.aborted) return null
      try {
        const { barcodes } = await p.BarcodeScanner.scan()
        // the system UI cannot be cancelled from JS; honour an abort that happened meanwhile
        if (signal?.aborted) return null
        const hit = barcodes.find((b) => b.rawValue)
        return hit?.rawValue ? { text: hit.rawValue, format: hit.format } : null
      } catch (e) {
        if (isCancellation(e)) return null
        if (/denied/i.test(String((e as Error)?.message ?? ''))) throw new DeviceError('cameraDenied', e)
        throw new DeviceError('scanFailed', e)
      }
    },
  }
}

/** Opens the app's system settings page (after a permission denial). */
export async function openNativeSettings(): Promise<void> {
  const { BarcodeScanner } = await plugin()
  await BarcodeScanner.openSettings()
}
