import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SyncStore } from './contracts'

export const useSyncStore = defineStore('st-sync', (): SyncStore => ({
  syncing: ref(false),
  lastSyncAt: ref(null),
  pendingEvents: ref(0),
  pendingBlobs: ref(0),
  lastError: ref(null),
  syncNow: async () => {},
}))
