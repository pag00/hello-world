<script setup lang="ts">
// One NCR: details, its event history in the run ledger, and the supervisor actions — disposition and
// close — which are run events (ncr.dispositioned / ncr.closed) signed via PinDialog (role supervisor).
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NcrDisposition, RunEvent } from '../domain/types'
import type { Signer } from '../stores/contracts'
import { findStep } from '../domain/projection'
import { useProceduresStore, useRegistryStore, useRunsStore, useSessionStore } from '../stores'
import PinDialog from '../components/session/PinDialog.vue'
import NcrStatusBadge from '../components/quality/NcrStatusBadge.vue'
import { fmtDateTime } from '../components/run/format'
import { errorText } from '../components/authoring/errors'

const props = defineProps<{ ncrId: string }>()
const { t, locale } = useI18n()
const registry = useRegistryStore()
const runs = useRunsStore()
const procedures = useProceduresStore()
const session = useSessionStore()

const DISPOSITIONS: NcrDisposition[] = ['use_as_is', 'rework', 'repair', 'scrap', 'return_to_supplier']

const ncr = computed(() => registry.ncrs.find((n) => n.id === props.ncrId) ?? null)
const run = computed(() => (ncr.value ? (runs.runs.find((r) => r.id === ncr.value!.run_id) ?? null) : null))
const revision = computed(() => (run.value ? procedures.getRevision(run.value.revision_id) : null))
const procedure = computed(() => procedures.procedures.find((p) => p.id === run.value?.procedure_id) ?? null)
const step = computed(() => (revision.value && ncr.value?.step_id ? findStep(revision.value.content, ncr.value.step_id) : null))
const input = computed(() => (step.value && ncr.value?.input_id ? (step.value.inputs.find((i) => i.id === ncr.value!.input_id) ?? null) : null))

// the run's ledger is the authority for the NCR's lifecycle; load it so the store can validate actions
const loaded = ref(false)
async function load() {
  loaded.value = false
  if (ncr.value) await runs.loadEvents(ncr.value.run_id).catch(() => undefined)
  loaded.value = true
}
onMounted(load)
watch(() => ncr.value?.run_id, load)

const history = computed(() =>
  ncr.value
    ? runs.events(ncr.value.run_id).filter((e) => e.type.startsWith('ncr.') && (e.payload as { ncr_id?: string }).ncr_id === props.ncrId)
    : [],
)

const runClosed = computed(() => run.value?.status === 'completed' || run.value?.status === 'aborted')
const isSupervisor = computed(() => session.hasRole('supervisor'))
const canDisposition = computed(() => ncr.value?.status === 'open' && !runClosed.value)
const canClose = computed(() => ncr.value?.status === 'dispositioned' && !runClosed.value)

// ---- actions
const disposition = ref<NcrDisposition | null>(null)
const note = ref('')
const pending = ref<'disposition' | 'close' | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
const done = ref<string | null>(null)

const dispositionValid = computed(() => !!disposition.value && note.value.trim().length > 0)

function ask(kind: 'disposition' | 'close') {
  error.value = null
  done.value = null
  if (kind === 'disposition' && !dispositionValid.value) return
  pending.value = kind
}

async function onSigned(signer: Signer) {
  const kind = pending.value
  pending.value = null
  if (!ncr.value || !kind) return
  busy.value = true
  try {
    if (kind === 'disposition') {
      await runs.dispositionNcr({ runId: ncr.value.run_id, ncrId: ncr.value.id, disposition: disposition.value!, note: note.value, signer })
      disposition.value = null
      note.value = ''
      done.value = t('st.quality.ncr.dispositionDone')
    } else {
      await runs.closeNcr(ncr.value.run_id, ncr.value.id, signer)
      done.value = t('st.quality.ncr.closeDone')
    }
  } catch (e) {
    error.value = errorText(e, t)
  } finally {
    busy.value = false
  }
}

const eventLabel = (e: RunEvent) => t(`st.quality.record.eventTypes.${e.type.replace('.', '_')}`)
</script>

<template>
  <div class="st-page st-stack">
    <RouterLink :to="{ name: 'st-ncrs' }" class="st-ncr__back">← {{ t('st.quality.ncr.listTitle') }}</RouterLink>

    <template v-if="ncr">
      <div class="st-row">
        <h1 class="st-h1 st-mono">{{ ncr.number ?? t('st.quality.ncr.pendingNumber') }}</h1>
        <NcrStatusBadge :status="ncr.status" />
      </div>

      <section class="st-card st-stack">
        <p class="st-ncr__desc">{{ ncr.description }}</p>
        <dl class="st-ncr__meta">
          <dt>{{ t('st.quality.ncr.run') }}</dt>
          <dd>
            <template v-if="run">
              <span class="st-mono">{{ procedure?.number }}</span> {{ t('st.quality.ncr.revShort', { rev: revision?.rev ?? '?' }) }} ·
              {{ t('st.quality.record.serial') }} <strong class="st-mono">{{ run.serial }}</strong>
              <RouterLink :to="{ name: 'st-run-record', params: { runId: run.id } }" class="st-btn st-ncr__link" data-test="run-link">
                {{ t('st.quality.ncr.openRecord') }}
              </RouterLink>
            </template>
            <span v-else class="st-muted">{{ t('st.quality.ncr.runNotLocal') }}</span>
          </dd>
          <dt>{{ t('st.quality.ncr.step') }}</dt>
          <dd>
            <template v-if="ncr.step_id">
              {{ step?.title ?? t('st.quality.ncr.unknownStep') }}
              <span v-if="input" class="st-muted">› {{ input.label }}</span>
              <RouterLink
                v-if="run"
                :to="{ name: 'st-run-step', params: { runId: run.id, stepId: ncr.step_id } }"
                class="st-btn st-ncr__link"
                data-test="step-link"
              >
                {{ t('st.quality.ncr.openStep') }}
              </RouterLink>
            </template>
            <span v-else>{{ t('st.quality.ncr.runLevel') }}</span>
          </dd>
          <dt>{{ t('st.quality.ncr.raised') }}</dt>
          <dd>{{ registry.userName(ncr.raised_by) }} · {{ fmtDateTime(ncr.raised_at, locale) }}</dd>
          <template v-if="ncr.disposition">
            <dt>{{ t('st.quality.ncr.disposition') }}</dt>
            <dd>
              <strong>{{ t(`st.quality.ncr.dispositions.${ncr.disposition}`) }}</strong> — {{ ncr.disposition_note }}
              <span class="st-hint">({{ registry.userName(ncr.dispositioned_by) }}, {{ fmtDateTime(ncr.dispositioned_at, locale) }})</span>
            </dd>
          </template>
          <template v-if="ncr.closed_at">
            <dt>{{ t('st.quality.ncr.closed') }}</dt>
            <dd>{{ registry.userName(ncr.closed_by) }} · {{ fmtDateTime(ncr.closed_at, locale) }}</dd>
          </template>
        </dl>
      </section>

      <p v-if="done" class="st-alert st-alert--ok" role="status" data-test="done">{{ done }}</p>
      <p v-if="error" class="st-alert st-alert--danger" role="alert" data-test="error">{{ error }}</p>
      <p v-if="runClosed && ncr.status !== 'closed'" class="st-alert st-alert--warn">{{ t('st.quality.ncr.runClosed') }}</p>

      <section v-if="isSupervisor && canDisposition && run" class="st-card st-stack" data-test="disposition-form">
        <h2 class="st-h2">{{ t('st.quality.ncr.dispositionTitle') }}</h2>
        <div class="st-ncr__choices" role="radiogroup" :aria-label="t('st.quality.ncr.disposition')">
          <label v-for="d in DISPOSITIONS" :key="d" class="st-ncr__choice" :class="{ 'st-ncr__choice--on': disposition === d }">
            <input v-model="disposition" type="radio" name="disposition" :value="d" :data-disposition="d" />
            {{ t(`st.quality.ncr.dispositions.${d}`) }}
          </label>
        </div>
        <label>
          <span class="st-label">{{ t('st.quality.ncr.note') }} <span class="st-hint">({{ t('st.common.required') }})</span></span>
          <textarea v-model="note" class="st-textarea" rows="3" data-test="note" />
        </label>
        <div class="st-row">
          <span class="st-spacer" />
          <button type="button" class="st-btn st-btn--primary st-btn--lg" :disabled="!dispositionValid || busy" data-test="disposition-submit" @click="ask('disposition')">
            {{ t('st.quality.ncr.dispositionSubmit') }}
          </button>
        </div>
      </section>

      <section v-if="isSupervisor && canClose && run" class="st-card st-row" data-test="close-form">
        <p class="st-ncr__close-text">{{ t('st.quality.ncr.closeHint') }}</p>
        <span class="st-spacer" />
        <button type="button" class="st-btn st-btn--primary st-btn--lg" :disabled="busy" data-test="close-submit" @click="ask('close')">
          {{ t('st.quality.ncr.close') }}
        </button>
      </section>
      <p v-if="!isSupervisor && ncr.status !== 'closed'" class="st-hint">{{ t('st.quality.ncr.supervisorOnly') }}</p>

      <section class="st-stack">
        <h2 class="st-h2">{{ t('st.quality.ncr.history') }}</h2>
        <p v-if="loaded && !history.length" class="st-muted">{{ t('st.quality.ncr.noHistory') }}</p>
        <ul class="st-ncr__history">
          <li v-for="e in history" :key="e.id">
            <strong>{{ eventLabel(e) }}</strong> · {{ registry.userName(e.actor_id) }}
            <span class="st-badge">{{ t(`st.quality.record.auth.${e.auth_method}`) }}</span>
            <span v-if="e.offline" class="st-badge st-badge--warn">{{ t('st.quality.record.offline') }}</span>
            · {{ fmtDateTime(e.client_ts, locale) }}
            <span class="st-mono st-hint">{{ e.seq != null ? `#${e.seq}` : t('st.quality.record.localEvent') }}</span>
          </li>
        </ul>
      </section>

      <PinDialog
        :open="!!pending"
        role="supervisor"
        :title="pending === 'close' ? t('st.quality.ncr.signClose') : t('st.quality.ncr.signDisposition')"
        @signed="onSigned"
        @close="pending = null"
      />
    </template>
    <p v-else class="st-alert st-alert--warn" data-test="ncr-missing">{{ t('st.quality.ncr.notFound') }}</p>
  </div>
</template>

<style scoped>
.st-ncr__back { color: var(--st-primary); text-decoration: none; font-weight: 600; min-height: var(--st-touch); display: inline-flex; align-items: center; }
.st-ncr__desc { font-size: 1.15rem; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.st-ncr__meta { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 0; align-items: center; }
.st-ncr__meta dt { color: var(--st-text-muted); font-weight: 600; }
.st-ncr__meta dd { margin: 0; }
.st-ncr__link { margin-left: 8px; }
.st-ncr__choices { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.st-ncr__choice {
  display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 0 14px; font-weight: 600;
  border: 2px solid var(--st-border); border-radius: var(--st-radius); cursor: pointer; background: var(--st-surface);
}
.st-ncr__choice input { width: 24px; height: 24px; }
.st-ncr__choice--on { border-color: var(--st-primary); background: var(--st-info-bg); }
.st-ncr__close-text { margin: 0; flex: 1 1 300px; }
.st-ncr__history { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
</style>
