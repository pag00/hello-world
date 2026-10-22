<script setup lang="ts">
// Nonconformance register, filterable by status. Includes NCRs raised offline on this device
// (mirrored locally from their ncr.raised events until the server assigns a number).
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { NcrStatus } from '../domain/types'
import { useRegistryStore } from '../stores'
import NcrTable from '../components/quality/NcrTable.vue'

type Filter = NcrStatus | 'all' | 'not_closed'
const FILTERS: Filter[] = ['not_closed', 'open', 'dispositioned', 'closed', 'all']

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const registry = useRegistryStore()

// filter lives in the query so the list can be bookmarked / come back to the same view
const filter = computed<Filter>(() => {
  const q = route.query.status
  return typeof q === 'string' && (FILTERS as string[]).includes(q) ? (q as Filter) : 'not_closed'
})
function setFilter(f: Filter) {
  void router.replace({ query: { ...route.query, status: f } })
}

const count = (f: Filter) => registry.ncrs.filter((n) => matches(f, n.status)).length
function matches(f: Filter, s: NcrStatus) {
  return f === 'all' || (f === 'not_closed' ? s !== 'closed' : s === f)
}
const shown = computed(() => registry.ncrs.filter((n) => matches(filter.value, n.status)))
</script>

<template>
  <div class="st-page st-stack">
    <h1 class="st-h1">{{ t('st.quality.ncr.listTitle') }}</h1>
    <div class="st-row" role="tablist">
      <button
        v-for="f in FILTERS"
        :key="f"
        type="button"
        role="tab"
        class="st-btn"
        :class="{ 'st-btn--primary': filter === f }"
        :aria-selected="filter === f"
        :data-filter="f"
        @click="setFilter(f)"
      >
        {{ t(`st.quality.ncr.filter.${f}`) }} <span class="st-badge">{{ count(f) }}</span>
      </button>
    </div>
    <p v-if="!shown.length" class="st-muted" data-test="ncr-empty">{{ t('st.quality.ncr.empty') }}</p>
    <div v-else class="st-card">
      <NcrTable :ncrs="shown" show-run />
    </div>
  </div>
</template>
