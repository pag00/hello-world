<script setup lang="ts">
// Printable A4 traveller that accompanies the unit: run QR (scan to open the run on any tablet),
// procedure/revision/serial and a numbered step list with workstations and blank signature lines.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useStepTrackConfig } from '../config'
import { useProceduresStore, useRunsStore } from '../stores'
import QrCode from '../components/QrCode.vue'
import { labelUrl } from '../components/quality/labels'
import { shortHash } from '../components/authoring/revisions'
import { fmtDateTime } from '../components/run/format'

const props = defineProps<{ runId: string }>()
const { t, locale } = useI18n()
const cfg = useStepTrackConfig()
const runs = useRunsStore()
const procedures = useProceduresStore()

const run = computed(() => runs.runs.find((r) => r.id === props.runId) ?? null)
const revision = computed(() => (run.value ? procedures.getRevision(run.value.revision_id) : null))
const procedure = computed(() => procedures.procedures.find((p) => p.id === run.value?.procedure_id) ?? null)
const qrUrl = computed(() => labelUrl('run', props.runId, cfg))
const printedAt = new Date().toISOString()

function print() {
  window.print()
}
</script>

<template>
  <div class="st-page st-traveller">
    <div class="st-row st-noprint st-traveller__bar">
      <RouterLink v-if="run" :to="{ name: 'st-run', params: { runId: run.id } }" class="st-traveller__back">← {{ t('st.quality.record.backToRun') }}</RouterLink>
      <span class="st-spacer" />
      <button type="button" class="st-btn st-btn--primary" data-test="print" @click="print">{{ t('st.quality.print') }}</button>
    </div>

    <article v-if="run" class="st-traveller__sheet">
      <header class="st-traveller__head">
        <div class="st-traveller__ids">
          <div class="st-traveller__kicker">{{ t('st.quality.traveller.title') }}</div>
          <h1 class="st-traveller__proc"><span class="st-mono">{{ procedure?.number ?? '—' }}</span> {{ procedure?.title }}</h1>
          <table class="st-traveller__meta">
            <tbody>
              <tr>
                <th>{{ t('st.quality.record.revision') }}</th>
                <td class="st-mono">{{ revision?.rev ?? '—' }}</td>
                <th>{{ t('st.quality.record.contentHash') }}</th>
                <td class="st-mono">{{ shortHash(revision?.content_hash, 16) }}</td>
              </tr>
              <tr>
                <th>{{ t('st.quality.record.serial') }}</th>
                <td class="st-mono st-traveller__serial" data-test="serial">{{ run.serial }}</td>
                <th>{{ t('st.quality.record.workOrder') }}</th>
                <td class="st-mono">{{ run.work_order || '—' }}</td>
              </tr>
              <tr>
                <th>{{ t('st.quality.record.runId') }}</th>
                <td class="st-mono st-traveller__small" colspan="3">{{ run.id }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <figure class="st-traveller__qr">
          <QrCode :value="qrUrl" size="38mm" :label="t('st.quality.traveller.qrLabel')" />
          <figcaption class="st-traveller__small">{{ t('st.quality.traveller.scanHint') }}</figcaption>
        </figure>
      </header>

      <table v-if="revision" class="st-traveller__steps" data-test="traveller-steps">
        <thead>
          <tr>
            <th class="st-traveller__c-num">#</th>
            <th>{{ t('st.quality.traveller.step') }}</th>
            <th class="st-traveller__c-ws">{{ t('st.quality.traveller.workstation') }}</th>
            <th class="st-traveller__c-sig">{{ t('st.quality.traveller.operator') }}</th>
            <th class="st-traveller__c-sig">{{ t('st.quality.traveller.inspector') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="(sec, si) in revision.content.sections" :key="sec.id">
            <tr class="st-traveller__sec">
              <td colspan="5">{{ si + 1 }}. {{ sec.title }}</td>
            </tr>
            <tr v-for="(st, i) in sec.steps" :key="st.id" :data-step="st.id">
              <td class="st-mono">{{ si + 1 }}.{{ i + 1 }}</td>
              <td>
                {{ st.title }}
                <div v-if="st.inputs.some((x) => x.type === 'number')" class="st-traveller__small">
                  <span v-for="x in st.inputs.filter((y) => y.type === 'number')" :key="x.id" class="st-traveller__lim">
                    {{ x.label }}: ______ {{ x.type === 'number' ? x.unit : '' }}
                  </span>
                </div>
              </td>
              <td class="st-mono">{{ st.locations.join(', ') || '—' }}</td>
              <td class="st-traveller__line"><span>{{ t('st.quality.traveller.signDate') }}</span></td>
              <td class="st-traveller__line" :class="{ 'st-traveller__na': !st.verification?.required }">
                <span v-if="st.verification?.required">{{ t('st.quality.traveller.signDate') }}</span>
                <span v-else>{{ t('st.quality.traveller.notRequired') }}</span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <p v-else class="st-alert st-alert--warn">{{ t('st.quality.record.revisionMissing') }}</p>

      <footer class="st-traveller__foot st-traveller__small">
        <span>{{ t('st.quality.traveller.printed', { at: fmtDateTime(printedAt, locale) }) }}</span>
        <span>{{ t('st.quality.traveller.footer') }}</span>
      </footer>
    </article>
    <p v-else class="st-alert st-alert--warn">{{ t('st.quality.record.runMissing') }}</p>
  </div>
</template>

<style scoped>
.st-traveller__back { color: var(--st-primary); text-decoration: none; font-weight: 600; min-height: var(--st-touch); display: inline-flex; align-items: center; }
.st-traveller__bar { margin-bottom: 12px; }
.st-traveller__sheet { background: #fff; color: #000; padding: 12mm; max-width: 210mm; margin: 0 auto; box-shadow: var(--st-shadow); }
.st-traveller__head { display: flex; gap: 8mm; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #000; padding-bottom: 4mm; }
.st-traveller__kicker { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.8rem; font-weight: 700; }
.st-traveller__proc { font-size: 1.4rem; margin: 2mm 0; }
.st-traveller__meta { border-collapse: collapse; font-size: 0.95rem; }
.st-traveller__meta th { text-align: left; padding: 1mm 3mm 1mm 0; font-weight: 600; color: #444; white-space: nowrap; }
.st-traveller__meta td { padding: 1mm 6mm 1mm 0; }
.st-traveller__serial { font-size: 1.3rem; font-weight: 700; }
.st-traveller__qr { margin: 0; text-align: center; }
.st-traveller__small { font-size: 0.75rem; }
.st-traveller__steps { width: 100%; border-collapse: collapse; margin-top: 4mm; font-size: 0.9rem; }
.st-traveller__steps th, .st-traveller__steps td { border: 1px solid #000; padding: 2mm; vertical-align: top; text-align: left; }
.st-traveller__steps thead th { background: #eee; }
.st-traveller__steps tr { break-inside: avoid; page-break-inside: avoid; }
.st-traveller__sec td { background: #f4f4f4; font-weight: 700; }
.st-traveller__c-num { width: 12mm; }
.st-traveller__c-ws { width: 22mm; }
.st-traveller__c-sig { width: 38mm; }
.st-traveller__line { height: 12mm; vertical-align: bottom !important; }
.st-traveller__line span { font-size: 0.65rem; color: #666; }
.st-traveller__na { background: repeating-linear-gradient(135deg, #fff 0 4px, #eee 4px 8px); }
.st-traveller__lim { margin-right: 4mm; display: inline-block; }
.st-traveller__foot { display: flex; justify-content: space-between; margin-top: 4mm; color: #444; }
@media print {
  @page { size: A4; margin: 10mm; }
  .st-traveller { padding: 0; max-width: none; }
  .st-traveller__sheet { padding: 0; box-shadow: none; max-width: none; }
  .st-traveller__steps thead { display: table-header-group; }
}
</style>
