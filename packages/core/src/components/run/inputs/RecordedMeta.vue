<script setup lang="ts">
// Who recorded the current value, when, how (manual / OCR / scan, PIN or sign-in), and earlier values.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InputValue, RunEvent } from '../../../domain/types'
import { useRegistryStore } from '../../../stores'
import { fmtDateTime } from '../format'

const props = defineProps<{ event: RunEvent<'input.recorded'> | null; history?: RunEvent<'input.recorded'>[]; unit?: string }>()
const { t, locale } = useI18n()
const registry = useRegistryStore()
const showHistory = ref(false)

const SHOWN_FLAGS = ['conflict', 'unlocked', 'late_lock', 'tool_expired', 'tool_unknown', 'blob_missing'] as const
const flags = computed(() => (props.event?.flags ?? []).filter((f) => (SHOWN_FLAGS as readonly string[]).includes(f)))

function valueText(v: InputValue): string {
  if (v === true) return t('st.run.value.yes')
  if (Array.isArray(v)) return t('st.run.value.photos', { n: v.length }, v.length)
  return props.unit ? `${v} ${props.unit}` : v
}
</script>

<template>
  <div v-if="event" class="st-meta" data-test="recorded-meta">
    <span>{{ t('st.run.meta.by', { name: registry.userName(event.actor_id), time: fmtDateTime(event.client_ts, locale) }) }}</span>
    <span class="st-badge" data-test="meta-source">{{ t(`st.run.source.${event.payload.source}`) }}</span>
    <span v-if="event.auth_method === 'pin'" class="st-badge">{{ t('st.run.meta.pin') }}</span>
    <span v-if="event.offline" class="st-badge">{{ t('st.run.meta.offline') }}</span>
    <span v-if="event.seq == null" class="st-badge st-badge--info">{{ t('st.run.meta.notSynced') }}</span>
    <span v-for="f in flags" :key="f" class="st-badge st-badge--warn">{{ t(`st.run.flag.${f}`) }}</span>
    <span v-if="event.payload.source === 'ocr' && event.payload.ocr_raw !== undefined" class="st-hint">
      {{ t('st.run.meta.ocrRaw', { raw: event.payload.ocr_raw }) }}
    </span>
    <button v-if="history?.length" type="button" class="st-btn st-btn--ghost st-meta__toggle" @click="showHistory = !showHistory">
      {{ t('st.run.meta.history', { n: history.length }, history.length) }}
    </button>
    <ol v-if="showHistory && history?.length" class="st-meta__history" data-test="meta-history">
      <li v-for="h in history" :key="h.id">
        <s>{{ valueText(h.payload.value) }}</s>
        — {{ t('st.run.meta.by', { name: registry.userName(h.actor_id), time: fmtDateTime(h.client_ts, locale) }) }}
        · {{ t(`st.run.source.${h.payload.source}`) }}
      </li>
    </ol>
  </div>
</template>

<style scoped>
.st-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 0.9rem; color: var(--st-text-muted); }
.st-meta__toggle { min-height: 36px; padding: 0 8px; font-size: 0.85rem; }
.st-meta__history { width: 100%; margin: 4px 0 0; padding-left: 20px; }
</style>
