<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Ncr } from '../../domain/types'
import { findStep } from '../../domain/projection'
import { useProceduresStore, useRegistryStore, useRunsStore } from '../../stores'
import { fmtDateTime } from '../run/format'
import NcrStatusBadge from './NcrStatusBadge.vue'

const props = defineProps<{ ncrs: Ncr[]; showRun?: boolean }>()
const { t, locale } = useI18n()
const registry = useRegistryStore()
const runs = useRunsStore()
const procedures = useProceduresStore()

const rows = computed(() =>
  props.ncrs.map((n) => {
    const run = runs.runs.find((r) => r.id === n.run_id) ?? null
    const rev = run ? procedures.getRevision(run.revision_id) : null
    const proc = run ? procedures.procedures.find((p) => p.id === run.procedure_id) : null
    const step = rev && n.step_id ? findStep(rev.content, n.step_id) : null
    return { ncr: n, run, proc, step }
  }),
)
</script>

<template>
  <div class="st-ncr-table">
    <table class="st-table" data-test="ncr-table">
      <thead>
        <tr>
          <th>{{ t('st.quality.ncr.number') }}</th>
          <th>{{ t('st.quality.ncr.statusLabel') }}</th>
          <th>{{ t('st.quality.ncr.description') }}</th>
          <th v-if="showRun">{{ t('st.quality.ncr.run') }}</th>
          <th>{{ t('st.quality.ncr.step') }}</th>
          <th>{{ t('st.quality.ncr.raised') }}</th>
          <th>{{ t('st.quality.ncr.disposition') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.ncr.id" :data-ncr="r.ncr.id">
          <td>
            <RouterLink :to="{ name: 'st-ncr', params: { ncrId: r.ncr.id } }" class="st-ncr-table__link st-mono">
              {{ r.ncr.number ?? t('st.quality.ncr.pendingNumber') }}
            </RouterLink>
          </td>
          <td><NcrStatusBadge :status="r.ncr.status" /></td>
          <td class="st-ncr-table__desc">{{ r.ncr.description }}</td>
          <td v-if="showRun">
            <template v-if="r.run">
              <span class="st-mono">{{ r.proc?.number }}</span> · {{ r.run.serial }}
            </template>
            <span v-else class="st-muted">—</span>
          </td>
          <td>{{ r.step?.title ?? (r.ncr.step_id ? t('st.quality.ncr.unknownStep') : t('st.quality.ncr.runLevel')) }}</td>
          <td>
            {{ registry.userName(r.ncr.raised_by) }}<br />
            <span class="st-hint">{{ fmtDateTime(r.ncr.raised_at, locale) }}</span>
          </td>
          <td>
            <template v-if="r.ncr.disposition">{{ t(`st.quality.ncr.dispositions.${r.ncr.disposition}`) }}</template>
            <span v-else class="st-muted">—</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.st-ncr-table { overflow-x: auto; }
.st-ncr-table__link { display: inline-flex; align-items: center; min-height: var(--st-touch); color: var(--st-primary); font-weight: 700; }
.st-ncr-table__desc { max-width: 28em; overflow-wrap: anywhere; }
</style>
