<script setup lang="ts">
// NCRs of one run (optionally one step). NCRs raised offline show up immediately; their number is
// assigned by the server at sync.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RevisionContent, Uuid } from '../../domain/types'
import { useRegistryStore } from '../../stores'
import { flattenSteps } from './runNav'

const props = defineProps<{ runId: Uuid; content: RevisionContent | null; stepId?: Uuid | null; canRaise?: boolean }>()
const emit = defineEmits<{ raise: [] }>()
const { t } = useI18n()
const registry = useRegistryStore()

const refs = computed(() => flattenSteps(props.content))
const ncrs = computed(() =>
  registry.ncrs.filter((n) => n.run_id === props.runId && (props.stepId == null || n.step_id === props.stepId)),
)

const TONE = { open: 'st-badge--danger', dispositioned: 'st-badge--warn', closed: 'st-badge--ok' } as const

function stepLabel(stepId: Uuid | null) {
  if (!stepId) return t('st.run.ncr.runLevel')
  const r = refs.value.find((x) => x.step.id === stepId)
  return r ? `${r.number} ${r.step.title}` : '—'
}
</script>

<template>
  <section class="st-card st-stack" data-test="ncr-list">
    <div class="st-row">
      <h2 class="st-h2">{{ t('st.run.ncr.title') }}</h2>
      <span class="st-spacer" />
      <button v-if="canRaise" type="button" class="st-btn" data-test="raise-run-ncr" @click="emit('raise')">{{ t('st.run.ncr.raise') }}</button>
    </div>
    <p v-if="!ncrs.length" class="st-muted">{{ t('st.run.ncr.none') }}</p>
    <ul v-else class="st-ncrs">
      <li v-for="n in ncrs" :key="n.id">
        <RouterLink :to="{ name: 'st-ncr', params: { ncrId: n.id } }" class="st-ncrs__item">
          <span class="st-ncrs__main">
            <strong class="st-mono">{{ n.number ?? t('st.run.ncr.noNumber') }}</strong>
            <span>{{ n.description }}</span>
            <span class="st-hint">{{ stepLabel(n.step_id) }}</span>
          </span>
          <span class="st-badge" :class="TONE[n.status]">{{ t(`st.run.ncr.status.${n.status}`) }}</span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.st-ncrs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.st-ncrs__item {
  display: flex; align-items: center; gap: 12px; padding: 10px 12px; min-height: var(--st-touch);
  border: 1px solid var(--st-border); border-radius: var(--st-radius); color: inherit; text-decoration: none;
}
.st-ncrs__main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
</style>
