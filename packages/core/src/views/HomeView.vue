<script setup lang="ts">
// Tablet start screen: scan anything, continue this tablet's runs, start a run, recent runs.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Run } from '../domain/types'
import { useProceduresStore, useRunsStore, useSessionStore } from '../stores'
import ScanButton from '../components/device/ScanButton.vue'
import QrResultPanel from '../components/run/QrResultPanel.vue'
import RunStatusBadge from '../components/run/RunStatusBadge.vue'
import { deviceErrorText } from '../components/run/errors'
import { fmtDateTime } from '../components/run/format'
import { progressOf } from '../components/run/runNav'
import { useQrNavigation } from '../components/run/useQrNavigation'

const { t, locale } = useI18n()
const runs = useRunsStore()
const procedures = useProceduresStore()
const session = useSessionStore()
const qr = useQrNavigation()
const scanError = ref<string | null>(null)

const OPEN = new Set(['active', 'blocked'])

function onScan(text: string) {
  scanError.value = null
  void qr.handleText(text)
}
function onScanError(m: string) {
  scanError.value = deviceErrorText(m, t)
}

const nowIso = () => new Date().toISOString()
const checkedOutHere = (r: Run) => {
  const co = runs.checkoutOf(r.id)
  return !!co && co.holder_device === session.deviceId && co.expires_at > nowIso()
}

/** active run first, then runs checked out to this tablet */
const deviceRuns = computed(() => {
  const list = runs.runs.filter((r) => OPEN.has(r.status) && (r.id === runs.activeRunId || checkedOutHere(r)))
  return list.sort((a, b) => (a.id === runs.activeRunId ? -1 : b.id === runs.activeRunId ? 1 : 0))
})

const recent = computed(() => {
  const shown = new Set(deviceRuns.value.map((r) => r.id))
  return runs.runs.filter((r) => !shown.has(r.id)).slice(0, 8)
})

const released = computed(() =>
  procedures.procedures
    .map((p) => ({ procedure: p, revision: procedures.releasedRevision(p.id) }))
    .filter((x) => !!x.revision),
)

function procNumber(r: Run) {
  return procedures.procedures.find((p) => p.id === r.procedure_id)?.number ?? '—'
}
function procTitle(r: Run) {
  return procedures.procedures.find((p) => p.id === r.procedure_id)?.title ?? ''
}
function progress(r: Run) {
  return progressOf(procedures.getRevision(r.revision_id)?.content, runs.projection(r.id).value)
}
</script>

<template>
  <div class="st-page st-stack st-home">
    <div v-if="!session.online" class="st-alert st-alert--warn st-stack" data-test="offline-banner">
      <strong>{{ t('st.run.home.offlineTitle') }}</strong>
      <span>{{ t('st.run.home.offlineWorks') }}</span>
      <span>{{ t('st.run.home.offlineReadOnly') }}</span>
    </div>

    <section class="st-card st-stack st-home__scan">
      <ScanButton :label="t('st.run.home.scan')" size="lg" :disabled="qr.busy.value" @scanned="onScan" @error="onScanError" />
      <p class="st-hint">{{ t('st.run.home.scanHint') }}</p>
      <p v-if="scanError" class="st-alert st-alert--danger" role="alert">{{ scanError }}</p>
    </section>

    <QrResultPanel v-if="qr.result.value" :result="qr.result.value" @choose-run="qr.chooseRun" @clear="qr.clear" />

    <section class="st-stack" data-test="device-runs">
      <h2 class="st-h2">{{ t('st.run.home.thisTablet') }}</h2>
      <p v-if="!deviceRuns.length" class="st-muted">{{ t('st.run.home.noDeviceRuns') }}</p>
      <RouterLink
        v-for="r in deviceRuns"
        :key="r.id"
        :to="{ name: 'st-run', params: { runId: r.id } }"
        class="st-card st-home__run st-home__run--big"
        :data-test="`device-run-${r.id}`"
      >
        <span class="st-home__runmain">
          <strong class="st-mono st-home__serial">{{ r.serial }}</strong>
          <span>{{ procNumber(r) }} · {{ procTitle(r) }}</span>
          <span class="st-hint">{{ t('st.run.progress', progress(r)) }}</span>
        </span>
        <span class="st-home__runside">
          <span v-if="r.id === runs.activeRunId" class="st-badge st-badge--info">{{ t('st.run.activeRun') }}</span>
          <span v-if="checkedOutHere(r)" class="st-badge st-badge--ok">{{ t('st.run.home.checkedOut') }}</span>
          <RunStatusBadge :status="r.status" />
        </span>
      </RouterLink>
    </section>

    <section class="st-card st-stack" data-test="start-run">
      <div class="st-row">
        <h2 class="st-h2">{{ t('st.run.home.startTitle') }}</h2>
        <span class="st-spacer" />
        <RouterLink class="st-btn st-btn--primary" :to="{ name: 'st-run-new' }">{{ t('st.run.home.startRun') }}</RouterLink>
      </div>
      <p v-if="!released.length" class="st-muted">{{ t('st.run.home.noReleased') }}</p>
      <div v-else class="st-home__procs">
        <RouterLink
          v-for="x in released"
          :key="x.procedure.id"
          class="st-btn st-home__proc"
          :to="{ name: 'st-run-new', query: { procedureId: x.procedure.id } }"
        >
          <strong class="st-mono">{{ x.procedure.number }}</strong>
          <span class="st-badge">{{ t('st.run.revShort', { rev: x.revision!.rev }) }}</span>
          <span class="st-home__proctitle">{{ x.procedure.title }}</span>
        </RouterLink>
      </div>
    </section>

    <section class="st-stack" data-test="recent-runs">
      <div class="st-row">
        <h2 class="st-h2">{{ t('st.run.home.recent') }}</h2>
        <span class="st-spacer" />
        <RouterLink class="st-btn st-btn--ghost" :to="{ name: 'st-runs' }">{{ t('st.run.qr.allRuns') }}</RouterLink>
      </div>
      <p v-if="!recent.length" class="st-muted">{{ t('st.run.list.empty') }}</p>
      <RouterLink v-for="r in recent" :key="r.id" :to="{ name: 'st-run', params: { runId: r.id } }" class="st-card st-home__run">
        <span class="st-home__runmain">
          <strong class="st-mono">{{ r.serial }}</strong>
          <span class="st-muted">{{ procNumber(r) }} · {{ fmtDateTime(r.created_at, locale) }}</span>
        </span>
        <RunStatusBadge :status="r.status" />
      </RouterLink>
    </section>
  </div>
</template>

<style scoped>
.st-home__scan { align-items: stretch; text-align: center; }
.st-home__scan :deep(.st-btn) { min-height: 96px; font-size: 1.4rem; width: 100%; }
.st-home__run { display: flex; align-items: center; gap: 12px; color: inherit; text-decoration: none; padding: 12px 16px; }
.st-home__run--big { min-height: 88px; border-left: 6px solid var(--st-primary); }
.st-home__runmain { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.st-home__serial { font-size: 1.4rem; }
.st-home__runside { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.st-home__procs { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--st-gap); }
.st-home__proc { justify-content: flex-start; text-decoration: none; min-height: 64px; flex-wrap: wrap; text-align: left; }
.st-home__proctitle { font-weight: 400; flex-basis: 100%; }
</style>
