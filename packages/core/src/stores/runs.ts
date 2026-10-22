import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { RunsStore } from './contracts'
import type { Run } from '../domain/types'
import { notImplemented } from './_stub'

export const useRunsStore = defineStore('st-runs', (): RunsStore => {
  const runs = ref<Run[]>([])
  return {
    runs,
    activeRunId: ref(null),
    events: () => [],
    projection: () => computed(() => null),
    startRun: () => notImplemented('runs.startRun'),
    recordInput: () => notImplemented('runs.recordInput'),
    startStep: () => notImplemented('runs.startStep'),
    completeStep: () => notImplemented('runs.completeStep'),
    verifyStep: () => notImplemented('runs.verifyStep'),
    reopenStep: () => notImplemented('runs.reopenStep'),
    addNote: () => notImplemented('runs.addNote'),
    raiseNcr: () => notImplemented('runs.raiseNcr'),
    dispositionNcr: () => notImplemented('runs.dispositionNcr'),
    closeNcr: () => notImplemented('runs.closeNcr'),
    resolveConflict: () => notImplemented('runs.resolveConflict'),
    completeRun: () => notImplemented('runs.completeRun'),
    abortRun: () => notImplemented('runs.abortRun'),
    validateComplete: () => [],
    canEdit: () => ({ ok: true }),
    lockStep: () => notImplemented('runs.lockStep'),
    releaseStep: () => notImplemented('runs.releaseStep'),
    locks: () => [],
    checkout: () => notImplemented('runs.checkout'),
    releaseCheckout: () => notImplemented('runs.releaseCheckout'),
    checkoutOf: () => null,
  }
})
