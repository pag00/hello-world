import { defineStore } from 'pinia'
import { ref, type Ref } from 'vue'
import type { SyncStore } from './contracts'
import type { RejectedRow } from '../db'
import type { SyncErrorCode } from '../sync/engine'
import { getDb, getEngine, syncState } from '../sync/runtime'

export interface SyncStoreImpl extends SyncStore {
  online: Ref<boolean>
  lastErrorCode: Ref<SyncErrorCode | null>
  rejectedCount: Ref<number>
  /** events the server refused; kept forever, newest first */
  rejected: Ref<RejectedRow[]>
  loadRejected(): Promise<void>
  acknowledgeRejected(eventId: string): Promise<void>
  /** debounced sync (after local writes) */
  schedule(): void
}

export const useSyncStore = defineStore('st-sync', (): SyncStoreImpl => {
  const rejected = ref<RejectedRow[]>([])

  async function loadRejected() {
    rejected.value = (await getDb().rejected.toArray()).sort((a, b) => (a.rejected_at < b.rejected_at ? 1 : -1))
  }

  return {
    syncing: syncState.syncing,
    lastSyncAt: syncState.lastSyncAt,
    pendingEvents: syncState.pendingEvents,
    pendingBlobs: syncState.pendingBlobs,
    lastError: syncState.lastError,
    lastErrorCode: syncState.lastErrorCode,
    rejectedCount: syncState.rejectedCount,
    online: syncState.online,
    rejected,
    loadRejected,
    async acknowledgeRejected(eventId) {
      await getDb().rejected.update(eventId, { acknowledged: 1 })
      await loadRejected()
      await getEngine().refreshCounts()
    },
    syncNow: () => getEngine().syncNow(),
    schedule: () => getEngine().schedule(),
  }
})
