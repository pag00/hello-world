import { inject, type App, type InjectionKey } from 'vue'
import type { AuthProvider } from '../auth/types'
import type { DeviceAdapters } from '../device/types'

export interface StepTrackConfig {
  /** e.g. "https://steptrack.example.org/api" (no trailing slash) */
  apiBaseUrl: string
  /** mount path inside the host router, e.g. "/procedures-app"; "" or "/" for standalone */
  basePath: string
  auth: AuthProvider
  /** override device adapters (tests, host-specific hardware); defaults chosen by platform */
  device?: Partial<DeviceAdapters>
  /** public origin used when printing QR labels; defaults to window.location.origin */
  publicOrigin?: string
  /** IndexedDB database name; lets several instances coexist (tests, multi-tenant hosts) */
  dbName?: string
}

export const STEPTRACK_CONFIG: InjectionKey<StepTrackConfig> = Symbol('steptrack-config')

let globalConfig: StepTrackConfig | null = null

export function setStepTrackConfig(app: App, cfg: StepTrackConfig) {
  globalConfig = cfg
  app.provide(STEPTRACK_CONFIG, cfg)
}

/** Usable inside components (inject) and outside (stores, sync engine) after install. */
export function useStepTrackConfig(): StepTrackConfig {
  const injected = inject(STEPTRACK_CONFIG, null)
  const cfg = injected ?? globalConfig
  if (!cfg) throw new Error('StepTrack not installed: call installStepTrack(app, options) first')
  return cfg
}

export function getStepTrackConfig(): StepTrackConfig {
  if (!globalConfig) throw new Error('StepTrack not installed')
  return globalConfig
}
