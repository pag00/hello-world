<script setup lang="ts">
// Shows a QR scan result that is not a plain navigation: pick a run, pick a step, tool status, nothing found.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Run } from '../../domain/types'
import { useProceduresStore, useRegistryStore, useRunsStore } from '../../stores'
import type { QrResolution } from './qrRouting'
import { flattenSteps } from './runNav'
import StepStateBadge from './StepStateBadge.vue'
import RunStatusBadge from './RunStatusBadge.vue'

const props = defineProps<{ result: QrResolution }>()
const emit = defineEmits<{ chooseRun: [run: Run]; clear: [] }>()

const { t } = useI18n()
const procedures = useProceduresStore()
const registry = useRegistryStore()
const runs = useRunsStore()

function procLabel(run: Run) {
  const p = procedures.procedures.find((x) => x.id === run.procedure_id)
  const rev = procedures.getRevision(run.revision_id)
  return p ? `${p.number} ${rev ? t('st.run.revShort', { rev: rev.rev }) : ''} · ${p.title}` : t('st.run.unknownProcedure')
}

const stepRows = computed(() => {
  const r = props.result
  if (r.type !== 'choose-step') return []
  const refs = flattenSteps(procedures.getRevision(r.run.revision_id)?.content)
  const proj = runs.projection(r.run.id).value
  return r.stepIds
    .map((id) => refs.find((x) => x.step.id === id))
    .filter((x) => !!x)
    .map((x) => ({ ref: x!, state: proj?.steps[x!.step.id]?.state ?? 'pending' }))
})

const tool = computed(() => (props.result.type === 'tool' ? registry.checkTool(props.result.code) : null))
const toolTone = computed(() => (tool.value?.status === 'ok' ? 'ok' : 'danger'))
</script>

<template>
  <section class="st-card st-stack st-qr-result" aria-live="polite" data-test="qr-result">
    <template v-if="result.type === 'choose-run'">
      <h2 class="st-h2">
        {{ result.reason === 'workstation' ? t('st.run.qr.chooseRunWorkstation', { code: result.code }) : t('st.run.qr.chooseRunPart', { serial: result.code }) }}
      </h2>
      <p class="st-hint">{{ result.reason === 'workstation' ? t('st.run.qr.chooseRunWorkstationHint') : t('st.run.qr.chooseRunPartHint') }}</p>
      <ul class="st-qr-result__list">
        <li v-for="r in result.runs" :key="r.id">
          <button type="button" class="st-btn st-btn--block st-qr-result__item" :data-test="`qr-run-${r.id}`" @click="emit('chooseRun', r)">
            <span class="st-qr-result__main">
              <strong class="st-mono">{{ r.serial }}</strong>
              <span class="st-muted">{{ procLabel(r) }}</span>
            </span>
            <span v-if="runs.activeRunId === r.id" class="st-badge st-badge--info">{{ t('st.run.activeRun') }}</span>
            <RunStatusBadge :status="r.status" />
          </button>
        </li>
      </ul>
    </template>

    <template v-else-if="result.type === 'choose-step'">
      <h2 class="st-h2">{{ t('st.run.qr.nothingActionable', { code: result.code, serial: result.run.serial }) }}</h2>
      <p class="st-hint">{{ t('st.run.qr.nothingActionableHint') }}</p>
      <ul class="st-qr-result__list">
        <li v-for="row in stepRows" :key="row.ref.step.id">
          <RouterLink
            class="st-btn st-btn--block st-qr-result__item"
            :to="{ name: 'st-run-step', params: { runId: result.run.id, stepId: row.ref.step.id } }"
          >
            <span class="st-qr-result__main">
              <strong>{{ row.ref.number }} {{ row.ref.step.title }}</strong>
            </span>
            <StepStateBadge :state="row.state" />
          </RouterLink>
        </li>
      </ul>
      <RouterLink class="st-btn" :to="{ name: 'st-run', params: { runId: result.run.id } }">{{ t('st.run.qr.openRun') }}</RouterLink>
    </template>

    <template v-else-if="result.type === 'workstation-none'">
      <p class="st-alert st-alert--warn" role="alert">{{ t('st.run.qr.workstationNone', { code: result.code }) }}</p>
      <RouterLink class="st-btn" :to="{ name: 'st-runs' }">{{ t('st.run.qr.allRuns') }}</RouterLink>
    </template>

    <template v-else-if="result.type === 'part-none'">
      <p class="st-alert st-alert--info" role="status">{{ t('st.run.qr.partNone', { pn: result.part_number, serial: result.serial }) }}</p>
      <RouterLink class="st-btn st-btn--primary" :to="{ name: 'st-run-new', query: { serial: result.serial } }">
        {{ t('st.run.qr.startWithSerial', { serial: result.serial }) }}
      </RouterLink>
    </template>

    <template v-else-if="result.type === 'tool' && tool">
      <h2 class="st-h2">{{ t('st.run.qr.toolTitle', { code: result.code }) }}</h2>
      <p v-if="tool.tool" class="st-muted">{{ tool.tool.description }}</p>
      <p class="st-alert" :class="`st-alert--${toolTone}`" role="status" data-test="qr-tool-status">
        {{ t(`st.run.tool.${tool.status}`) }}
        <template v-if="tool.tool?.calibration_due">
          · {{ t('st.run.tool.due', { date: tool.tool.calibration_due }) }}
        </template>
      </p>
    </template>

    <template v-else-if="result.type === 'unknown'">
      <p class="st-alert st-alert--danger" role="alert">{{ t('st.run.qr.unknown') }}</p>
      <p class="st-mono st-qr-result__raw">{{ result.raw }}</p>
    </template>

    <div class="st-row">
      <span class="st-spacer" />
      <button type="button" class="st-btn st-btn--ghost" @click="emit('clear')">{{ t('st.run.qr.dismiss') }}</button>
    </div>
  </section>
</template>

<style scoped>
.st-qr-result__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.st-qr-result__item { justify-content: flex-start; text-align: left; min-height: 64px; text-decoration: none; gap: 12px; }
.st-qr-result__main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.st-qr-result__raw { word-break: break-all; }
</style>
