// Wires the pure QR resolver to the stores and the router. Used by HomeView (scan button),
// RunView (workstation scan) and QrResolveView (deep link / camera app opened a printed label).
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { parseQr } from '../../domain/qr'
import type { QrTarget, Run } from '../../domain/types'
import { useProceduresStore, useRunsStore, useSessionStore } from '../../stores'
import { resolveQr, resolveWorkstationInRun, type QrContext, type QrResolution } from './qrRouting'

const OPEN = new Set(['active', 'blocked'])

export function useQrNavigation() {
  const router = useRouter()
  const runs = useRunsStore()
  const procedures = useProceduresStore()
  const session = useSessionStore()

  const result = ref<QrResolution | null>(null)
  const busy = ref(false)

  function context(): QrContext {
    const now = new Date().toISOString()
    const deviceRunIds = new Set(
      runs.runs.filter((r) => {
        const co = runs.checkoutOf(r.id)
        return !!co && co.holder_device === session.deviceId && co.expires_at > now
      }).map((r) => r.id),
    )
    return {
      runs: runs.runs,
      activeRunId: runs.activeRunId,
      deviceRunIds,
      contentOf: (r: Run) => procedures.getRevision(r.revision_id)?.content ?? null,
      projectionOf: (r: Run) => runs.projection(r.id).value,
    }
  }

  async function go(r: QrResolution, replace: boolean) {
    if (r.type === 'navigate') {
      result.value = null
      if (r.to.name === 'st-run-step') runs.activeRunId = r.to.params.runId
      await (replace ? router.replace(r.to) : router.push(r.to))
    } else {
      result.value = r
    }
  }

  async function handle(target: QrTarget, opts: { replace?: boolean } = {}) {
    busy.value = true
    try {
      await session.ready()
      // projections of open runs need their ledgers in memory (closed ones load lazily)
      await Promise.all(runs.runs.filter((r) => OPEN.has(r.status)).map((r) => runs.loadEvents(r.id)))
      await go(resolveQr(target, context()), !!opts.replace)
    } finally {
      busy.value = false
    }
  }

  function handleText(text: string, opts: { replace?: boolean } = {}) {
    return handle(parseQr(text), opts)
  }

  /** Operator picked a run from a choose-run result. */
  async function chooseRun(run: Run) {
    const current = result.value
    if (current?.type === 'choose-run' && current.reason === 'workstation') {
      runs.activeRunId = run.id
      await runs.loadEvents(run.id)
      await go(resolveWorkstationInRun(run, current.code, context()), false)
    } else {
      result.value = null
      await router.push({ name: 'st-run', params: { runId: run.id } })
    }
  }

  function clear() {
    result.value = null
  }

  return { result, busy, handle, handleText, chooseRun, clear }
}
