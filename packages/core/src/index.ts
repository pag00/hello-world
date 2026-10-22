// Public API of @steptrack/core
export { installStepTrack, saveLocale, type InstallOptions } from './plugin'
export { createStepTrackRoutes } from './routes'
export { useStepTrackConfig, type StepTrackConfig } from './config'
export type * from './device/types'
export type * from './domain/types'
export * from './stores'
export { messages as stepTrackMessages } from './i18n'

// auth
export type { AuthProvider, AuthUser } from './auth/types'
export { DevAuthProvider, isDevAuthProvider, type DevAuthOptions } from './auth/dev'
export { OidcAuthProvider, type OidcAuthOptions } from './auth/oidc'
export { verifyPin, isValidPin } from './auth/pin'
export { installAuthGuard } from './auth/guard'

// domain helpers
export { canonicalJson, hashCanonical, eventContentHash, chainHash, sealEvent, GENESIS_CHAIN_HASH } from './domain/canonical'
export { projectRun, projectRunDetailed, orderEvents, findStep, findInput, allSteps } from './domain/projection'
export { ValidationError, validateEvent, completionProblems, matchesExpect, hasRequiredValue } from './domain/validation'
export { parseQr, buildQrUrl, buildQrText, qrTargetFromRoute } from './domain/qr'
export { uuidv7, isUuid } from './domain/uuid'
export { compareDecimal, normalizeDecimal, toFixedDecimals, isDecimal, parseDecimal } from './domain/decimal'
export { isOutOfTolerance } from './domain/limits'

// api & sync
export { apiRequest, apiFetch, ApiError, OfflineError } from './api/client'
export { api, type Api } from './api/endpoints'
export { SyncEngine, PendingSyncError, type SyncState, type PullSummary, type PushSummary } from './sync/engine'
export { disposeRuntime } from './sync/runtime'
export { StepTrackDB } from './db'

// components owned by the core-data workstream that hosts may reuse
export { default as SyncStatusBadge } from './components/SyncStatusBadge.vue'
export { default as PinDialog } from './components/session/PinDialog.vue'
export { default as BlobImage } from './components/session/BlobImage.vue'
export { resolveWorkstationStep, type WorkstationMatch } from './domain/workstation'
