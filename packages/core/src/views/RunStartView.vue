<script setup lang="ts">
// Start a run of a released procedure revision for one unit serial. Works offline: the run is then
// checked out to this tablet automatically (§6).
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { parseQr } from '../domain/qr'
import { useProceduresStore, useRunsStore, useSessionStore } from '../stores'
import ScanButton from '../components/device/ScanButton.vue'
import { deviceErrorText, errorLines } from '../components/run/errors'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const procedures = useProceduresStore()
const runs = useRunsStore()
const session = useSessionStore()

const procedureId = ref<string>('')
const serial = ref('')
const workOrder = ref('')
const busy = ref(false)
const errors = ref<string[]>([])
const scanNote = ref<string | null>(null)

const options = computed(() =>
  procedures.procedures
    .map((p) => ({ procedure: p, revision: procedures.releasedRevision(p.id) }))
    .filter((x) => !!x.revision),
)
const selected = computed(() => options.value.find((o) => o.procedure.id === procedureId.value) ?? null)

/** a unit with an open run of the same procedure is almost always a mistake (wrong label scanned) */
const duplicate = computed(() => {
  const s = serial.value.trim().toLowerCase()
  if (!s || !selected.value) return null
  return runs.runs.find((r) => r.procedure_id === selected.value!.procedure.id && r.serial.trim().toLowerCase() === s && (r.status === 'active' || r.status === 'blocked')) ?? null
})

function fromQuery() {
  const q = route.query
  if (typeof q.procedureId === 'string') procedureId.value = q.procedureId
  if (typeof q.serial === 'string' && !serial.value) serial.value = q.serial
}
onMounted(fromQuery)
watch(() => route.query, fromQuery)

function onSerialScan(text: string) {
  scanNote.value = null
  const target = parseQr(text)
  if (target.kind === 'part') {
    serial.value = target.serial
    scanNote.value = t('st.run.start.scannedPart', { pn: target.part_number })
  } else if (target.kind === 'unknown') {
    serial.value = text.trim()
  } else {
    scanNote.value = t('st.run.start.notASerial')
  }
}
function onScanError(m: string) {
  scanNote.value = deviceErrorText(m, t)
}

const canStart = computed(() => !!selected.value && !!serial.value.trim() && !busy.value)

async function start() {
  if (!canStart.value || !selected.value) return
  busy.value = true
  errors.value = []
  try {
    const run = await runs.startRun({ revisionId: selected.value.revision!.id, serial: serial.value, workOrder: workOrder.value || null })
    await router.push({ name: 'st-run', params: { runId: run.id } })
  } catch (e) {
    errors.value = errorLines(e, t)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="st-page st-stack st-start">
    <h1 class="st-h1">{{ t('st.run.start.title') }}</h1>
    <p v-if="!session.online" class="st-alert st-alert--info" data-test="start-offline">{{ t('st.run.start.offline') }}</p>

    <form class="st-card st-stack" @submit.prevent="start">
      <label class="st-stack">
        <span class="st-label">{{ t('st.run.start.procedure') }}</span>
        <select v-model="procedureId" class="st-select" data-test="start-procedure">
          <option value="" disabled>{{ t('st.run.start.chooseProcedure') }}</option>
          <option v-for="o in options" :key="o.procedure.id" :value="o.procedure.id">
            {{ o.procedure.number }} {{ t('st.run.revShort', { rev: o.revision!.rev }) }} — {{ o.procedure.title }}
          </option>
        </select>
      </label>
      <p v-if="!options.length" class="st-alert st-alert--warn">{{ t('st.run.home.noReleased') }}</p>
      <p v-if="selected" class="st-hint">{{ t('st.run.start.revisionNote', { rev: selected.revision!.rev }) }}</p>

      <div class="st-stack">
        <label class="st-label" for="st-start-serial">{{ t('st.run.serial') }}</label>
        <div class="st-row">
          <input id="st-start-serial" v-model="serial" class="st-input st-mono st-start__serial" autocomplete="off" data-test="start-serial" />
          <ScanButton :label="t('st.run.start.scanSerial')" @scanned="onSerialScan" @error="onScanError" />
        </div>
        <p v-if="scanNote" class="st-hint" role="status">{{ scanNote }}</p>
      </div>
      <p v-if="duplicate" class="st-alert st-alert--warn" data-test="start-duplicate">
        {{ t('st.run.start.duplicate', { serial: duplicate.serial }) }}
        <RouterLink :to="{ name: 'st-run', params: { runId: duplicate.id } }">{{ t('st.run.qr.openRun') }}</RouterLink>
      </p>

      <label class="st-stack">
        <span class="st-label">{{ t('st.run.workOrder') }} <span class="st-hint">({{ t('st.common.optional') }})</span></span>
        <input v-model="workOrder" class="st-input st-mono" autocomplete="off" data-test="start-wo" />
      </label>

      <p v-for="e in errors" :key="e" class="st-alert st-alert--danger" role="alert">{{ e }}</p>
      <button type="submit" class="st-btn st-btn--primary st-btn--lg" :disabled="!canStart" data-test="start-submit">{{ t('st.run.start.submit') }}</button>
    </form>
  </div>
</template>

<style scoped>
.st-start__serial { flex: 1; min-width: 14ch; font-size: 1.3rem; }
</style>
