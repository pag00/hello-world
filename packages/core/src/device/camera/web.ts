// Web camera: the OS camera via <input type=file capture=environment>. Works in every mobile browser and
// in an installed PWA without getUserMedia; the result is normalised by compressImage().
import type { CameraAdapter } from '../types'
import { DeviceError } from '../errors'
import { compressImage } from '../image'

/** How long after the page regains focus we wait for "change" before treating the picker as cancelled. */
const FOCUS_CANCEL_GRACE_MS = 1500

/**
 * Open the system camera/file picker. Must be called synchronously from a user gesture (click handler),
 * before any await, or browsers block the picker.
 */
export function pickImageFile(doc: Document = document): Promise<File | null> {
  return new Promise((resolve) => {
    const input = doc.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.setAttribute('capture', 'environment')
    input.style.position = 'fixed'
    input.style.left = '-10000px'
    input.setAttribute('aria-hidden', 'true')
    input.tabIndex = -1

    let settled = false
    let focusTimer: ReturnType<typeof setTimeout> | null = null
    const win = doc.defaultView
    const onFocus = () => {
      focusTimer = setTimeout(() => {
        if (!input.files?.length) finish(null)
      }, FOCUS_CANCEL_GRACE_MS)
    }
    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      if (focusTimer) clearTimeout(focusTimer)
      win?.removeEventListener('focus', onFocus)
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => finish(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => finish(null))
    // browsers without the "cancel" event: the page regaining focus with no file means cancel
    if (!('oncancel' in input)) win?.addEventListener('focus', onFocus)
    doc.body.appendChild(input)
    input.click()
  })
}

export function createWebCamera(): CameraAdapter {
  return {
    kind: 'web',
    async capturePhoto() {
      const file = await pickImageFile()
      if (!file) return null
      try {
        return await compressImage(file)
      } catch (e) {
        throw new DeviceError('imageUnreadable', e)
      }
    },
  }
}
