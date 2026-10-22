// Public API of @steptrack/core
export { installStepTrack, type InstallOptions } from './plugin'
export { createStepTrackRoutes } from './routes'
export { useStepTrackConfig, type StepTrackConfig } from './config'
export type { AuthProvider, AuthUser } from './auth/types'
export type * from './device/types'
export type * from './domain/types'
export * from './stores'
export { messages as stepTrackMessages } from './i18n'
