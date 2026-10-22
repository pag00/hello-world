// Everything a run screen needs about one run, derived reactively from the stores.
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { EditCheck } from '../../stores'
import { useProceduresStore, useRunsStore, useSessionStore } from '../../stores'
import { flattenSteps, progressOf } from './runNav'

const CLOSED = new Set(['completed', 'aborted'])

export function useRunContext(runId: Ref<string>) {
  const runs = useRunsStore()
  const procedures = useProceduresStore()
  const session = useSessionStore()

  // lease checks compare against the clock; re-evaluate periodically so expiry shows without interaction
  const now = ref(Date.now())
  const ticker = setInterval(() => (now.value = Date.now()), 15_000)
  onBeforeUnmount(() => clearInterval(ticker))

  const loaded = ref(false)
  watch(
    runId,
    async (id) => {
      loaded.value = false
      await session.ready()
      if (runs.getRun(id)) await runs.loadEvents(id)
      loaded.value = true
    },
    { immediate: true },
  )

  const run = computed(() => runs.runs.find((r) => r.id === runId.value) ?? null)
  const revision = computed(() => (run.value ? procedures.getRevision(run.value.revision_id) : null))
  const procedure = computed(() => (run.value ? (procedures.procedures.find((p) => p.id === run.value!.procedure_id) ?? null) : null))
  const content = computed(() => revision.value?.content ?? null)
  const projection = computed(() => runs.projection(runId.value).value)
  const steps = computed(() => flattenSteps(content.value))
  const status = computed(() => projection.value?.status ?? run.value?.status ?? 'active')
  const closed = computed(() => CLOSED.has(status.value))
  const progress = computed(() => progressOf(content.value, projection.value))

  const checkout = computed(() => {
    void now.value
    const co = runs.checkoutOf(runId.value)
    return co && Date.parse(co.expires_at) > Date.now() ? co : null
  })
  const checkedOutHere = computed(() => !!checkout.value && checkout.value.holder_device === session.deviceId)

  /** Run-level writes (NCR on the run, complete, abort) need no step lock, but offline need the checkout. */
  const runEdit = computed<EditCheck>(() => {
    if (closed.value) return { ok: false, reason: 'run_closed' }
    if (checkout.value && !checkedOutHere.value) return { ok: false, reason: 'checked_out_by_other' }
    if (checkedOutHere.value) return { ok: true }
    if (!session.online) return { ok: false, reason: 'offline_not_checked_out' }
    return { ok: true }
  })

  return { now, loaded, run, revision, procedure, content, projection, steps, status, closed, progress, checkout, checkedOutHere, runEdit }
}
