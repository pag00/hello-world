// Service worker registration for the installed PWA. Updates are offered, never forced: reloading in the
// middle of a step would lose unsaved input on screen (recorded events are safe in IndexedDB either way).
import { reactive } from 'vue'
import { Capacitor } from '@capacitor/core'
import { registerSW } from 'virtual:pwa-register'

const UPDATE_CHECK_MS = 60 * 60 * 1000

export const pwaState = reactive({
  needRefresh: false,
  offlineReady: false,
})

let updateSW: ((reload?: boolean) => Promise<void>) | null = null

export function registerServiceWorker(): void {
  // the APK serves its assets from the device; a service worker would only add staleness
  if (Capacitor.isNativePlatform() || !('serviceWorker' in navigator)) return
  updateSW = registerSW({
    onNeedRefresh() {
      pwaState.needRefresh = true
    },
    onOfflineReady() {
      pwaState.offlineReady = true
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return
      setInterval(() => {
        if (navigator.onLine) void registration.update().catch(() => undefined)
      }, UPDATE_CHECK_MS)
    },
    onRegisterError(e) {
      console.error('StepTrack: service worker registration failed', e)
    },
  })
}

export async function applyUpdate(): Promise<void> {
  pwaState.needRefresh = false
  await updateSW?.(true)
}

export function dismissPwaNotice(): void {
  pwaState.needRefresh = false
  pwaState.offlineReady = false
}
