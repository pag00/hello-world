// Native camera via @capacitor/camera (imported on first use). The photo is still passed through
// compressImage() so every path yields the same bounded, metadata-free JPEG.
import type { CameraAdapter } from '../types'
import { DeviceError, isCancellation } from '../errors'
import { compressImage } from '../image'

type Plugin = typeof import('@capacitor/camera')
let pluginPromise: Promise<Plugin> | null = null
const plugin = () => (pluginPromise ??= import('@capacitor/camera'))

/**
 * Compressed blob → native file URI of the original capture. Lets the native OCR adapter hand ML Kit a
 * file path (it cannot read a Blob) without a filesystem plugin.
 */
const nativeSources = new WeakMap<Blob, string>()

export function nativeSourceOf(blob: Blob): string | undefined {
  return nativeSources.get(blob)
}

async function ensurePermission(p: Plugin): Promise<void> {
  const ok = (s: string) => s === 'granted' || s === 'limited'
  let status = await p.Camera.checkPermissions()
  if (ok(status.camera)) return
  status = await p.Camera.requestPermissions({ permissions: ['camera'] })
  if (!ok(status.camera)) throw new DeviceError('cameraDenied')
}

export function createNativeCamera(): CameraAdapter {
  return {
    kind: 'native',
    async capturePhoto() {
      const p = await plugin()
      await ensurePermission(p)
      let result: Awaited<ReturnType<Plugin['Camera']['takePhoto']>>
      try {
        result = await p.Camera.takePhoto({
          quality: 90,
          correctOrientation: true,
          encodingType: p.EncodingType.JPEG,
          saveToGallery: false,
          cameraDirection: p.CameraDirection.Rear,
          editable: 'no',
          includeMetadata: false,
        })
      } catch (e) {
        if (isCancellation(e)) return null
        if (/denied|permission/i.test(String((e as Error)?.message ?? ''))) throw new DeviceError('cameraDenied', e)
        throw new DeviceError('cameraFailed', e)
      }
      if (!result.webPath) throw new DeviceError('cameraFailed', 'no webPath')
      let original: Blob
      try {
        original = await (await fetch(result.webPath)).blob()
      } catch (e) {
        throw new DeviceError('imageUnreadable', e)
      }
      let photo: Blob
      try {
        photo = await compressImage(original)
      } catch (e) {
        throw new DeviceError('imageUnreadable', e)
      }
      if (result.uri) nativeSources.set(photo, result.uri)
      return photo
    },
  }
}
