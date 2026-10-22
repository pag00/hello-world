<script setup lang="ts">
// Every event of the run in ledger order, including dead (superseded / conflict-rejected) ones, which
// are struck through but never hidden: the record must show what was corrected and how.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RevisionContent, RunEvent, Uuid } from '../../domain/types'
import { orderEvents } from '../../domain/projection'
import { useRegistryStore } from '../../stores'
import { fmtDateTime } from '../run/format'
import { shortHash } from '../authoring/revisions'
import { deadReasons, eventDetails, stepIndex, type DetailLine } from './timeline'

const props = defineProps<{ events: readonly RunEvent[]; content: RevisionContent | null; ncrNumber: (id: Uuid) => string }>()
const { t, locale } = useI18n()
const registry = useRegistryStore()

const ordered = computed(() => orderEvents(props.events))
const dead = computed(() => deadReasons(props.events))
const steps = computed(() => stepIndex(props.content))
const seqOf = computed(() => new Map(props.events.map((e) => [e.id, e.seq ?? null])))
const refLabel = (id: Uuid) => {
  const s = seqOf.value.get(id)
  return s != null ? `#${s}` : id.slice(-8)
}
const typeKey = (e: RunEvent) => `st.quality.record.eventTypes.${e.type.replace('.', '_')}`
function detailText(d: DetailLine): string {
  // enum-valued params are translated before interpolation
  const params = { ...d.params }
  if (d.key === 'source') params.v = t(`st.quality.record.sources.${params.v}`)
  if (d.key === 'ncrDispositioned') params.d = t(`st.quality.ncr.dispositions.${params.d}`)
  return t(`st.quality.record.detail.${d.key}`, params)
}
const flagTone = (f: string) => (f === 'conflict' || f === 'tool_expired' || f === 'tool_unknown' || f === 'out_of_tolerance' ? 'st-badge--danger' : 'st-badge--warn')
</script>

<template>
  <ol class="st-timeline" data-test="timeline">
    <li
      v-for="e in ordered"
      :key="e.id"
      class="st-timeline__ev"
      :class="{ 'st-timeline__ev--dead': dead.has(e.id) }"
      :data-event="e.id"
      :data-dead="dead.has(e.id) || undefined"
    >
      <div class="st-timeline__head">
        <span class="st-mono st-timeline__seq">{{ e.seq != null ? `#${e.seq}` : t('st.quality.record.localEvent') }}</span>
        <strong class="st-timeline__type">{{ t(typeKey(e)) }}</strong>
        <span v-if="e.step_id" class="st-timeline__step">
          <span class="st-mono">{{ steps.get(e.step_id)?.number ?? '?' }}</span>
          {{ steps.get(e.step_id)?.step.title ?? t('st.quality.record.unknownStep') }}
        </span>
        <span class="st-spacer" />
        <span v-if="dead.get(e.id)?.kind === 'superseded'" class="st-badge st-badge--danger" data-test="dead-superseded">
          {{ t('st.quality.record.superseded', { ref: refLabel(dead.get(e.id)!.by) }) }}
        </span>
        <span v-else-if="dead.get(e.id)?.kind === 'rejected'" class="st-badge st-badge--danger" data-test="dead-rejected">
          {{ t('st.quality.record.rejected', { ref: refLabel(dead.get(e.id)!.by) }) }}
        </span>
        <span v-if="e.supersedes" class="st-badge st-badge--info">{{ t('st.quality.record.corrects', { ref: refLabel(e.supersedes) }) }}</span>
        <span v-for="f in e.flags ?? []" :key="f" class="st-badge" :class="flagTone(f)" :data-flag="f">{{ t(`st.quality.record.flags.${f}`) }}</span>
      </div>
      <div class="st-timeline__meta">
        <span>{{ registry.userName(e.actor_id) }}</span>
        <span class="st-badge" :data-auth="e.auth_method">{{ t(`st.quality.record.auth.${e.auth_method}`) }}</span>
        <span v-if="e.offline" class="st-badge st-badge--warn" data-test="offline">{{ t('st.quality.record.offline') }}</span>
        <span :title="t('st.quality.record.clientTs')">{{ fmtDateTime(e.client_ts, locale) }}</span>
        <span v-if="e.server_ts" class="st-hint">{{ t('st.quality.record.serverTsShort', { ts: fmtDateTime(e.server_ts, locale) }) }}</span>
        <span class="st-mono st-hint" :title="e.content_hash">{{ shortHash(e.content_hash, 10) }}</span>
      </div>
      <ul v-if="eventDetails(e, content, ncrNumber).length" class="st-timeline__details">
        <li v-for="(d, i) in eventDetails(e, content, ncrNumber)" :key="i">
          {{ detailText(d) }}
        </li>
      </ul>
    </li>
  </ol>
</template>

<style scoped>
.st-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.st-timeline__ev { padding: 10px 0 10px 14px; border-left: 3px solid var(--st-border); border-bottom: 1px solid var(--st-border); break-inside: avoid; }
.st-timeline__ev--dead { opacity: 0.7; border-left-color: var(--st-danger); }
.st-timeline__ev--dead .st-timeline__type, .st-timeline__ev--dead .st-timeline__details { text-decoration: line-through; }
.st-timeline__head, .st-timeline__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.st-timeline__seq { min-width: 3.5em; color: var(--st-text-muted); }
.st-timeline__meta { font-size: 0.9rem; color: var(--st-text-muted); margin-top: 2px; }
.st-timeline__details { margin: 4px 0 0; padding-left: 18px; overflow-wrap: anywhere; }
</style>
