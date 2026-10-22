<script setup lang="ts">
// As-run record (ARCHITECTURE §10) from the local ledger: header, integrity verdict, step results,
// traceability (scans), NCRs and the full event timeline. Print-friendly; the server's PDF/JSON exports
// are downloadable when online.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Uuid } from '../domain/types'
import { apiFetch } from '../api/client'
import { deadEventIds } from '../domain/projection'
import { useProceduresStore, useRegistryStore, useRunsStore, useSessionStore, useSyncStore } from '../stores'
import RunStatusBadge from '../components/run/RunStatusBadge.vue'
import { fmtDateTime } from '../components/run/format'
import ChainVerification from '../components/quality/ChainVerification.vue'
import EventTimeline from '../components/quality/EventTimeline.vue'
import RecordSteps from '../components/quality/RecordSteps.vue'
import NcrTable from '../components/quality/NcrTable.vue'
import { scanRecords } from '../components/quality/timeline'
import { verifyRevisionHash } from '../components/quality/recordVerify'
import { errorText } from '../components/authoring/errors'

const props = defineProps<{ runId: string }>()
const { t, locale } = useI18n()
const runs = useRunsStore()
const procedures = useProceduresStore()
const registry = useRegistryStore()
const session = useSessionStore()
const sync = useSyncStore()

const run = computed(() => runs.runs.find((r) => r.id === props.runId) ?? null)
const revision = computed(() => (run.value ? procedures.getRevision(run.value.revision_id) : null))
const procedure = computed(() => procedures.procedures.find((p) => p.id === run.value?.procedure_id) ?? null)
const loaded = ref(false)
const events = computed(() => runs.events(props.runId))
const projection = computed(() => runs.projection(props.runId).value)

async function load() {
  loaded.value = false
  await runs.loadEvents(props.runId).catch(() => undefined)
  loaded.value = true
}
onMounted(load)
watch(() => props.runId, load)

const dead = computed(() => deadEventIds(events.value))
const scans = computed(() => scanRecords(revision.value?.content ?? null, events.value, dead.value))
const ncrs = computed(() => registry.ncrs.filter((n) => n.run_id === props.runId))
function ncrNumber(id: Uuid): string {
  const n = registry.ncrs.find((x) => x.id === id)
  return n?.number ?? t('st.quality.ncr.pendingNumber')
}
const createdEvent = computed(() => events.value.find((e) => e.type === 'run.created') ?? null)

const revHashOk = ref<boolean | null>(null)
watch(revision, async (r) => (revHashOk.value = r ? await verifyRevisionHash(r) : null), { immediate: true })

function toolDue(code: string): string | null {
  const tool = registry.checkTool(code).tool
  return tool ? tool.calibration_due : null
}

// ---- exports
const downloading = ref<'pdf' | 'json' | null>(null)
const downloadError = ref<string | null>(null)

function fileBase(): string {
  const parts = [procedure.value?.number, revision.value?.rev, run.value?.serial].filter(Boolean).join('_')
  return (parts || props.runId).replace(/[^\w.-]+/g, '-')
}

async function download(kind: 'pdf' | 'json') {
  downloadError.value = null
  downloading.value = kind
  try {
    // authenticated fetch (bearer/dev header) — a plain link would not carry the token
    const res = await apiFetch('GET', `/runs/${encodeURIComponent(props.runId)}/record.${kind}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileBase()}_record.${kind}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (e) {
    downloadError.value = errorText(e, t)
  } finally {
    downloading.value = null
  }
}

function print() {
  window.print()
}
</script>

<template>
  <div class="st-page st-stack st-record">
    <template v-if="run">
      <div class="st-row st-noprint">
        <RouterLink :to="{ name: 'st-run', params: { runId: run.id } }" class="st-record__back">← {{ t('st.quality.record.backToRun') }}</RouterLink>
        <span class="st-spacer" />
        <RouterLink :to="{ name: 'st-run-traveller', params: { runId: run.id } }" class="st-btn">{{ t('st.quality.traveller.open') }}</RouterLink>
        <button type="button" class="st-btn" data-test="print" @click="print">{{ t('st.quality.print') }}</button>
        <button type="button" class="st-btn" :disabled="!session.online || !!downloading" data-test="dl-pdf" @click="download('pdf')">
          {{ downloading === 'pdf' ? t('st.common.loading') : t('st.quality.record.downloadPdf') }}
        </button>
        <button type="button" class="st-btn" :disabled="!session.online || !!downloading" data-test="dl-json" @click="download('json')">
          {{ downloading === 'json' ? t('st.common.loading') : t('st.quality.record.downloadJson') }}
        </button>
      </div>
      <p v-if="downloadError" class="st-alert st-alert--danger st-noprint" role="alert">{{ downloadError }}</p>

      <header class="st-card st-record__head">
        <h1 class="st-h1">{{ t('st.quality.record.title') }}</h1>
        <dl class="st-record__meta">
          <dt>{{ t('st.quality.record.procedure') }}</dt>
          <dd><span class="st-mono">{{ procedure?.number ?? '—' }}</span> {{ procedure?.title }}</dd>
          <dt>{{ t('st.quality.record.revision') }}</dt>
          <dd class="st-mono">{{ revision?.rev ?? '—' }}</dd>
          <dt>{{ t('st.quality.record.contentHash') }}</dt>
          <dd class="st-mono st-record__hash">
            {{ revision?.content_hash ?? '—' }}
            <span v-if="revHashOk === true" class="st-badge st-badge--ok">{{ t('st.authoring.revision.hashOk') }}</span>
            <span v-else-if="revHashOk === false" class="st-badge st-badge--danger">{{ t('st.authoring.revision.hashBad') }}</span>
          </dd>
          <dt>{{ t('st.quality.record.serial') }}</dt>
          <dd class="st-mono st-record__serial">{{ run.serial }}</dd>
          <dt>{{ t('st.quality.record.workOrder') }}</dt>
          <dd>{{ run.work_order || '—' }}</dd>
          <dt>{{ t('st.quality.record.status') }}</dt>
          <dd><RunStatusBadge :status="projection?.status ?? run.status" /></dd>
          <dt>{{ t('st.quality.record.createdBy') }}</dt>
          <dd>
            {{ registry.userName(run.created_by) }} · {{ fmtDateTime(run.created_at, locale) }}
            <span v-if="createdEvent?.offline" class="st-badge st-badge--warn">{{ t('st.quality.record.offline') }}</span>
          </dd>
          <dt>{{ t('st.quality.record.closedAt') }}</dt>
          <dd>{{ fmtDateTime(run.closed_at, locale) }}</dd>
          <dt>{{ t('st.quality.record.runId') }}</dt>
          <dd class="st-mono">{{ run.id }}</dd>
        </dl>
      </header>

      <ChainVerification :run-id="run.id" :events="events" />

      <p v-if="!loaded" class="st-muted">{{ t('st.common.loading') }}</p>
      <p v-else-if="!revision" class="st-alert st-alert--warn">{{ t('st.quality.record.revisionMissing') }}</p>

      <section v-if="revision" class="st-stack">
        <h2 class="st-h2">{{ t('st.quality.record.steps') }}</h2>
        <RecordSteps :content="revision.content" :projection="projection" :events="events" />
      </section>

      <section class="st-stack st-record__block">
        <h2 class="st-h2">{{ t('st.quality.record.traceability') }}</h2>
        <p v-if="!scans.length" class="st-muted">{{ t('st.quality.record.noScans') }}</p>
        <table v-else class="st-table" data-test="scans">
          <thead>
            <tr>
              <th>{{ t('st.quality.record.step') }}</th>
              <th>{{ t('st.quality.record.input') }}</th>
              <th>{{ t('st.quality.record.entity') }}</th>
              <th>{{ t('st.quality.record.scanned') }}</th>
              <th>{{ t('st.quality.record.calibration') }}</th>
              <th>{{ t('st.quality.record.recordedBy') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in scans" :key="s.event.id" :class="{ 'st-record__dead': s.dead }" :data-dead="s.dead || undefined">
              <td>{{ s.step.title }}</td>
              <td>{{ s.input.label }}</td>
              <td>{{ t(`st.authoring.input.entities.${s.input.entity}`) }}</td>
              <td class="st-mono">
                {{ s.value }}
                <span v-if="s.dead" class="st-badge st-badge--danger">{{ t('st.quality.record.dead') }}</span>
              </td>
              <td>
                <template v-if="s.input.entity === 'tool'">
                  <span v-for="f in (s.event.flags ?? []).filter((x) => x.startsWith('tool_'))" :key="f" class="st-badge st-badge--danger">
                    {{ t(`st.quality.record.flags.${f}`) }}
                  </span>
                  <span v-if="s.event.seq != null && !(s.event.flags ?? []).some((x) => x.startsWith('tool_'))" class="st-badge st-badge--ok">
                    {{ t('st.quality.record.calibrationOkAtIngest') }}
                  </span>
                  <span v-else-if="s.event.seq == null" class="st-badge">{{ t('st.quality.record.calibrationPending') }}</span>
                  <span class="st-hint">{{ t('st.quality.record.calibrationDueNow', { due: toolDue(s.value) ?? '—' }) }}</span>
                </template>
                <span v-else class="st-muted">—</span>
              </td>
              <td>
                {{ registry.userName(s.event.actor_id) }}<br />
                <span class="st-hint">{{ fmtDateTime(s.event.client_ts, locale) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="st-stack st-record__block">
        <h2 class="st-h2">{{ t('st.quality.record.ncrs') }}</h2>
        <p v-if="!ncrs.length" class="st-muted">{{ t('st.quality.record.noNcrs') }}</p>
        <NcrTable v-else :ncrs="ncrs" />
        <ul v-if="ncrs.some((n) => n.disposition_note)" class="st-record__notes">
          <li v-for="n in ncrs.filter((x) => x.disposition_note)" :key="n.id">
            <strong class="st-mono">{{ n.number ?? t('st.quality.ncr.pendingNumber') }}</strong>:
            {{ t(`st.quality.ncr.dispositions.${n.disposition}`) }} — {{ n.disposition_note }}
            <span class="st-hint">({{ registry.userName(n.dispositioned_by) }}, {{ fmtDateTime(n.dispositioned_at, locale) }})</span>
          </li>
        </ul>
      </section>

      <section class="st-stack st-record__block">
        <h2 class="st-h2">{{ t('st.quality.record.timeline', { n: events.length }) }}</h2>
        <p class="st-hint">{{ t('st.quality.record.timelineHint') }}</p>
        <EventTimeline :events="events" :content="revision?.content ?? null" :ncr-number="ncrNumber" />
      </section>
    </template>

    <div v-else class="st-stack">
      <p class="st-alert st-alert--warn" data-test="run-missing">{{ t('st.quality.record.runMissing') }}</p>
      <div>
        <button v-if="session.online" type="button" class="st-btn" :disabled="sync.syncing" @click="sync.syncNow()">{{ t('st.quality.syncNow') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.st-record__back { color: var(--st-primary); text-decoration: none; font-weight: 600; min-height: var(--st-touch); display: inline-flex; align-items: center; }
.st-record__meta { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.st-record__meta dt { color: var(--st-text-muted); font-weight: 600; }
.st-record__meta dd { margin: 0; }
.st-record__hash { overflow-wrap: anywhere; }
.st-record__serial { font-size: 1.2rem; font-weight: 700; }
.st-record__dead td { text-decoration: line-through; opacity: 0.7; }
.st-record__notes { margin: 0; padding-left: 18px; }
.st-record__block { break-inside: auto; }
@media print {
  .st-record { max-width: none; padding: 0; }
  .st-record .st-card { box-shadow: none; }
  .st-record h2 { break-after: avoid; }
}
</style>
