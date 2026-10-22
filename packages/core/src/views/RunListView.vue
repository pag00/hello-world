<script setup lang="ts">
// All runs known to this device, filtered by status and serial. Filters live in the query string so
// "back" from a run returns to the same list.
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { parseQr } from '../domain/qr'
import type { Run, RunStatus } from '../domain/types'
import { useProceduresStore, useRunsStore } from '../stores'
import ScanButton from '../components/device/ScanButton.vue'
import RunStatusBadge from '../components/run/RunStatusBadge.vue'
import { fmtDateTime } from '../components/run/format'

type Filter = 'open' | 'all' | RunStatus
const FILTERS: Filter[] = ['open', 'active', 'blocked', 'completed', 'aborted', 'all']

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const runs = useRunsStore()
const procedures = useProceduresStore()

const filter = computed<Filter>(() => {
  const s = route.query.status
  return typeof s === 'string' && (FILTERS as string[]).includes(s) ? (s as Filter) : 'open'
})
const search = computed(() => (typeof route.query.q === 'string' ? route.query.q : ''))

function setQuery(patch: Record<string, string | undefined>) {
  void router.replace({ query: { ...route.query, ...patch } })
}

function matchesFilter(r: Run, f: Filter) {
  if (f === 'all') return true
  if (f === 'open') return r.status === 'active' || r.status === 'blocked'
  return r.status === f
}

const counts = computed(() => Object.fromEntries(FILTERS.map((f) => [f, runs.runs.filter((r) => matchesFilter(r, f)).length])) as Record<Filter, number>)

const list = computed(() => {
  const q = search.value.trim().toLowerCase()
  return runs.runs.filter((r) => {
    if (!matchesFilter(r, filter.value)) return false
    if (!q) return true
    return r.serial.toLowerCase().includes(q) || (r.work_order ?? '').toLowerCase().includes(q)
  })
})

function proc(r: Run) {
  const p = procedures.procedures.find((x) => x.id === r.procedure_id)
  const rev = procedures.getRevision(r.revision_id)
  return { number: p?.number ?? '—', title: p?.title ?? '', rev: rev?.rev ?? '?' }
}

function onScan(text: string) {
  const target = parseQr(text)
  if (target.kind === 'run') return void router.push({ name: 'st-run', params: { runId: target.run_id } })
  setQuery({ q: target.kind === 'part' ? target.serial : text.trim(), status: 'all' })
}
</script>

<template>
  <div class="st-page st-stack">
    <div class="st-row">
      <h1 class="st-h1">{{ t('st.run.list.title') }}</h1>
      <span class="st-spacer" />
      <RouterLink class="st-btn st-btn--primary" :to="{ name: 'st-run-new' }">{{ t('st.run.home.startRun') }}</RouterLink>
    </div>

    <div class="st-row st-runlist__filters" role="radiogroup" :aria-label="t('st.run.list.filter')">
      <button
        v-for="f in FILTERS"
        :key="f"
        type="button"
        role="radio"
        class="st-btn"
        :class="{ 'st-btn--primary': filter === f }"
        :aria-checked="filter === f"
        :data-test="`filter-${f}`"
        @click="setQuery({ status: f === 'open' ? undefined : f })"
      >
        {{ t(`st.run.list.filters.${f}`) }} <span class="st-runlist__count">{{ counts[f] }}</span>
      </button>
    </div>

    <div class="st-row">
      <input
        :value="search"
        class="st-input st-runlist__search"
        type="search"
        :placeholder="t('st.run.list.searchPlaceholder')"
        :aria-label="t('st.run.list.searchPlaceholder')"
        data-test="run-search"
        @input="setQuery({ q: ($event.target as HTMLInputElement).value || undefined })"
      />
      <ScanButton :label="t('st.run.list.scanSerial')" @scanned="onScan" />
    </div>

    <p v-if="!list.length" class="st-muted" data-test="run-list-empty">{{ search ? t('st.run.list.noMatch', { q: search }) : t('st.run.list.empty') }}</p>
    <ul v-else class="st-runlist">
      <li v-for="r in list" :key="r.id">
        <RouterLink :to="{ name: 'st-run', params: { runId: r.id } }" class="st-runlist__item" :data-test="`run-${r.id}`">
          <span class="st-runlist__main">
            <strong class="st-mono st-runlist__serial">{{ r.serial }}</strong>
            <span>{{ proc(r).number }} {{ t('st.run.revShort', { rev: proc(r).rev }) }} · {{ proc(r).title }}</span>
            <span class="st-hint">
              {{ fmtDateTime(r.created_at, locale) }}
              <template v-if="r.work_order"> · {{ t('st.run.workOrder') }} <span class="st-mono">{{ r.work_order }}</span></template>
            </span>
          </span>
          <span v-if="r.id === runs.activeRunId" class="st-badge st-badge--info">{{ t('st.run.activeRun') }}</span>
          <RunStatusBadge :status="r.status" />
        </RouterLink>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.st-runlist__filters { gap: 8px; }
.st-runlist__count { font-weight: 400; opacity: 0.8; }
.st-runlist__search { flex: 1; min-width: 16ch; }
.st-runlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.st-runlist__item {
  display: flex; align-items: center; gap: 12px; padding: 12px 16px; min-height: 72px;
  background: var(--st-surface); border: 1px solid var(--st-border); border-radius: var(--st-radius);
  color: inherit; text-decoration: none;
}
.st-runlist__main { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.st-runlist__serial { font-size: 1.25rem; }
</style>
