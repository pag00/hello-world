// Device failures carry an i18n key as message; device components emit it and consumers translate it
// with deviceErrorText(). Keys live in i18n/<locale>/device.json.

export type DeviceErrorCode =
  | 'cameraDenied'
  | 'noCamera'
  | 'cameraBusy'
  | 'insecureContext'
  | 'scannerUnsupported'
  | 'scannerModuleUnavailable'
  | 'scannerModuleFailed'
  | 'noPreview'
  | 'ocrUnavailable'
  | 'ocrFailed'
  | 'imageUnreadable'
  | 'cameraFailed'
  | 'scanFailed'

export class DeviceError extends Error {
  constructor(
    readonly code: DeviceErrorCode,
    readonly detail?: unknown,
  ) {
    super(`st.device.errors.${code}`)
    this.name = 'DeviceError'
  }
}

/** Map getUserMedia/DOMException failures to our codes. */
export function mediaError(e: unknown, fallback: DeviceErrorCode = 'cameraFailed'): DeviceError {
  if (e instanceof DeviceError) return e
  const name = (e as { name?: string } | null)?.name
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new DeviceError('cameraDenied', e)
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new DeviceError('noCamera', e)
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new DeviceError('cameraBusy', e)
    default:
      return new DeviceError(fallback, e)
  }
}

/** i18n key (or plain message) suitable for a component's `error` emit. */
export function errorMessage(e: unknown, fallback: DeviceErrorCode): string {
  if (e instanceof DeviceError) return e.message
  return new DeviceError(fallback, e).message
}

/** Capacitor plugins reject cancellations with free-text messages ("scan canceled.", "User cancelled photos app"). */
export function isCancellation(e: unknown): boolean {
  const msg = (e as { message?: string } | null)?.message ?? String(e ?? '')
  return /cancel+ed|canceled|cancelled|no image picked/i.test(msg)
}
