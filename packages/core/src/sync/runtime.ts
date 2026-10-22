// Process-wide singletons (database, sync engine) shared by the Pinia stores. Created lazily from the
// installed config so a store can be instantiated before installStepTrack finished (or in tests).
import { getStepTrackConfig } from '../config'
import { StepTrackDB } from '../db'
import type { Uuid } from '../domain/types'
import { createSyncState, SyncEngine, type PullSummary, type PushSummary, type SyncState } from './engine'

export interface RuntimeHooks {
  deviceId: () => Uuid
  userId: () => Uuid | null
  onPulled: (s: PullSummary) => void | Promise<void>
  onPushed: (s: PushSummary) => void | Promise<void>
  onLocalChange: () => void | Promise<void>
}

const noopHooks = (): RuntimeHooks => ({
  deviceId: () => '',
  userId: () => null,
  onPulled: () => {},
  onPushed: () => {},
  onLocalChange: () => {},
})

export const syncState: SyncState = createSyncState()
let hooks: RuntimeHooks = noopHooks()
let db: StepTrackDB | null = null
let engine: SyncEngine | null = null

export function bindRuntimeHooks(h: Partial<RuntimeHooks>): void {
  hooks = { ...hooks, ...h }
}

export function getDb(): StepTrackDB {
  if (!db) db = new StepTrackDB(getStepTrackConfig().dbName ?? 'steptrack')
  return db
}

export function getEngine(): SyncEngine {
  if (!engine) {
    engine = new SyncEngine({
      db: getDb(),
      state: syncState,
      deviceId: () => hooks.deviceId(),
      userId: () => hooks.userId(),
      onPulled: (s) => hooks.onPulled(s),
      onPushed: (s) => hooks.onPushed(s),
      onLocalChange: () => hooks.onLocalChange(),
    })
  }
  return engine
}

/** Stop the engine and close the database (tests, host app teardown). Local data stays on disk. */
export function disposeRuntime(): void {
  engine?.stop()
  engine = null
  db?.close()
  db = null
  hooks = noopHooks()
  const fresh = createSyncState()
  for (const k of Object.keys(fresh) as (keyof SyncState)[]) {
    ;(syncState[k] as { value: unknown }).value = fresh[k].value
  }
}
