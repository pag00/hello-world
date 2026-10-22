// Platform detection. @capacitor/core is safe to import on the web (it only reports "web");
// the native plugins themselves are always imported dynamically by the native adapters.
import { Capacitor } from '@capacitor/core'

export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

export function platformName(): string {
  try {
    return Capacitor.getPlatform()
  } catch {
    return 'web'
  }
}
