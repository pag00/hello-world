<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Procedure, ProcedureRevision, Run, RunStatus } from '../../domain/types'
import RunStatusBadge from './RunStatusBadge.vue'

const props = defineProps<{
  run: Run
  procedure: Procedure | null
  revision: ProcedureRevision | null
  status: RunStatus
  progress?: { done: number; total: number }
  compact?: boolean
}>()
const { t } = useI18n()
const pct = computed(() => (props.progress && props.progress.total ? Math.round((props.progress.done / props.progress.total) * 100) : 0))
</script>

<template>
  <header class="st-runhead" :class="{ 'st-runhead--compact': compact }" data-test="run-header">
    <div class="st-runhead__ids">
      <span class="st-runhead__proc">
        <strong class="st-mono">{{ procedure?.number ?? t('st.run.unknownProcedure') }}</strong>
        <span v-if="revision" class="st-badge">{{ t('st.run.revShort', { rev: revision.rev }) }}</span>
        <span v-if="revision?.status === 'obsolete'" class="st-badge st-badge--warn" :title="t('st.run.obsoleteHint')">{{ t('st.run.obsolete') }}</span>
        <span v-if="procedure && !compact" class="st-muted st-runhead__title">{{ procedure.title }}</span>
      </span>
      <span class="st-runhead__serial">
        <span class="st-hint">{{ t('st.run.serial') }}</span>
        <strong class="st-mono" data-test="run-serial">{{ run.serial }}</strong>
        <template v-if="run.work_order">
          <span class="st-hint">{{ t('st.run.workOrder') }}</span>
          <span class="st-mono">{{ run.work_order }}</span>
        </template>
      </span>
    </div>
    <div class="st-runhead__state">
      <RunStatusBadge :status="status" />
      <span v-if="progress" class="st-hint" data-test="run-progress">{{ t('st.run.progress', progress) }}</span>
    </div>
    <div v-if="progress && !compact" class="st-runhead__bar" aria-hidden="true"><span :style="{ width: `${pct}%` }" /></div>
  </header>
</template>

<style scoped>
.st-runhead { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
.st-runhead__ids { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.st-runhead__proc { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 1.1rem; }
.st-runhead__title { font-size: 1rem; }
.st-runhead__serial { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; }
.st-runhead__serial strong { font-size: 1.5rem; }
.st-runhead--compact .st-runhead__serial strong { font-size: 1.15rem; }
.st-runhead__state { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.st-runhead__bar { flex-basis: 100%; height: 8px; border-radius: 4px; background: var(--st-surface-2); overflow: hidden; }
.st-runhead__bar span { display: block; height: 100%; background: var(--st-ok); }
</style>
