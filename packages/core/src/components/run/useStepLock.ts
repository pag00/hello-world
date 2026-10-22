// Step lease while a step screen is open (§6): acquire on enter (online, no checkout), release on leave
// or when moving to another step. Heartbeats are the sync engine's job.
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { ApiError, OfflineError } from '../../api/client'
import { useRunsStore, useSessionStore } from '../../stores'

export type LockState = 'idle' | 'acquiring' | 'held' | 'refused' | 'not_needed' | 'offline' | 'error'

export function useStepLock(opts: {
  runId: Ref<string>
  stepId: Ref<string>
  /** wait until the run is loaded before deciding */
  ready: Ref<boolean>
  closed: Ref<boolean>
  /** any live checkout of the run (mine or someone else's): no step lock is requested */
  checkedOut: Ref<boolean>
  now: Ref<number>
}) {
  const runs = useRunsStore()
  const session = useSessionStore()
  const state = ref<LockState>('idle')
  const error = ref<unknown>(null)
  let held: { runId: string; stepId: string } | null = null
  let generation = 0

  async function release() {
    const h = held
    held = null
    if (!h) return
    try {
      await runs.releaseStep(h.runId, h.stepId)
    } catch {
      // offline or already gone: the lease simply expires on the server
    }
  }

  async function acquire(force = false) {
    const mine = ++generation
    const runId = opts.runId.value
    const stepId = opts.stepId.value
    error.value = null
    if (!opts.ready.value) return
    if (opts.closed.value || opts.checkedOut.value || !runs.getRun(runId)) {
      state.value = 'not_needed'
      return
    }
    if (!session.online) {
      state.value = 'offline'
      return
    }
    state.value = 'acquiring'
    try {
      await runs.lockStep(runId, stepId, force ? { force: true } : undefined)
      if (mine !== generation) {
        // the operator already moved on; give the lease back right away
        await runs.releaseStep(runId, stepId).catch(() => {})
        return
      }
      held = { runId, stepId }
      state.value = 'held'
    } catch (e) {
      if (mine !== generation) return
      error.value = e
      if (e instanceof ApiError && e.status === 409) state.value = 'refused'
      else if (e instanceof OfflineError) state.value = 'offline'
      else state.value = 'error'
    }
  }

  watch(
    [opts.runId, opts.stepId, opts.ready, opts.closed, opts.checkedOut],
    async () => {
      await release()
      await acquire()
    },
    { immediate: true },
  )

  // back online → try again; went offline → the lease cannot be renewed, canEdit explains the rest
  watch(
    () => session.online,
    (online) => {
      if (online && (state.value === 'offline' || state.value === 'error')) void acquire()
    },
  )

  onBeforeUnmount(() => {
    generation++
    void release()
  })

  /** someone else's live lease on this step, if the server told us about it */
  const foreign = computed(() => {
    void opts.now.value
    const nowIso = new Date().toISOString()
    return runs.locks(opts.runId.value).find(
      (l) => l.step_id === opts.stepId.value && l.holder_device !== session.deviceId && l.expires_at > nowIso,
    ) ?? null
  })

  return { state, error, foreign, acquire, release }
}
