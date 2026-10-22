<script setup lang="ts">
// Per-step section of the as-run record: state, who completed/verified, and every input's current
// (live) value against its limits, with photos.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Input, RevisionContent, RunEvent, RunProjection, Uuid } from '../../domain/types'
import { useRegistryStore } from '../../stores'
import { fmtDateTime } from '../run/format'
import StepStateBadge from '../run/StepStateBadge.vue'
import BlobImage from '../session/BlobImage.vue'
import { formatValue } from './timeline'

const props = defineProps<{ content: RevisionContent; projection: RunProjection | null; events: readonly RunEvent[] }>()
const { t, locale } = useI18n()
const registry = useRegistryStore()

const byId = computed(() => new Map(props.events.map((e) => [e.id, e])))

function limits(inp: Input): string {
  if (inp.type !== 'number') return ''
  const u = inp.unit ? ` ${inp.unit}` : ''
  const parts: string[] = []
  if (inp.min != null && inp.min !== '') parts.push(`${t('st.quality.record.min')} ${inp.min}`)
  if (inp.nominal != null && inp.nominal !== '') parts.push(`${t('st.quality.record.nominal')} ${inp.nominal}`)
  if (inp.max != null && inp.max !== '') parts.push(`${t('st.quality.record.max')} ${inp.max}`)
  return parts.length ? parts.join(' · ') + u : t('st.quality.record.noLimits')
}

function recorded(stepId: Uuid, inputId: Uuid) {
  const ip = props.projection?.steps[stepId]?.inputs[inputId]
  const ev = ip?.event_id ? byId.value.get(ip.event_id) : undefined
  return { ip, ev: ev as RunEvent<'input.recorded'> | undefined }
}

function photos(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : []
}
</script>

<template>
  <div class="st-rsteps st-stack">
    <section v-for="(sec, si) in content.sections" :key="sec.id" class="st-rsteps__sec">
      <h3 class="st-h2">{{ si + 1 }}. {{ sec.title }}</h3>
      <article v-for="(st, i) in sec.steps" :key="st.id" class="st-rsteps__step st-card" :data-step="st.id">
        <header class="st-row">
          <span class="st-mono st-rsteps__num">{{ si + 1 }}.{{ i + 1 }}</span>
          <strong>{{ st.title }}</strong>
          <StepStateBadge v-if="projection?.steps[st.id]" :state="projection.steps[st.id]!.state" />
          <span v-for="c in st.locations" :key="c" class="st-badge st-mono">{{ c }}</span>
        </header>
        <p v-if="projection?.steps[st.id]?.completed_by" class="st-rsteps__sig">
          {{ t('st.quality.record.completedBy', { name: registry.userName(projection.steps[st.id]!.completed_by), at: fmtDateTime(projection.steps[st.id]!.completed_at, locale) }) }}
        </p>
        <p v-if="projection?.steps[st.id]?.verified_by" class="st-rsteps__sig">
          {{ t('st.quality.record.verifiedBy', { name: registry.userName(projection.steps[st.id]!.verified_by), at: fmtDateTime(projection.steps[st.id]!.verified_at, locale) }) }}
        </p>
        <p v-else-if="st.verification?.required" class="st-rsteps__sig st-muted">
          {{ t('st.quality.record.verificationRequired', { role: t(`st.authoring.roles.${st.verification.role}`) }) }}
        </p>

        <table v-if="st.inputs.length" class="st-table st-rsteps__inputs">
          <thead>
            <tr>
              <th>{{ t('st.quality.record.input') }}</th>
              <th>{{ t('st.quality.record.value') }}</th>
              <th>{{ t('st.quality.record.limits') }}</th>
              <th>{{ t('st.quality.record.recordedBy') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="inp in st.inputs" :key="inp.id" :data-input="inp.id">
              <td>
                {{ inp.label }}
                <span v-if="inp.required" class="st-hint">*</span>
              </td>
              <td>
                <template v-if="inp.type === 'photo'">
                  <div class="st-rsteps__photos">
                    <BlobImage v-for="p in photos(recorded(st.id, inp.id).ip?.value)" :key="p" :ref-id="p" thumb :alt="inp.label" />
                  </div>
                  <span v-if="!photos(recorded(st.id, inp.id).ip?.value).length" class="st-muted">—</span>
                </template>
                <template v-else>
                  <span class="st-mono st-rsteps__value">{{ formatValue(inp, recorded(st.id, inp.id).ip?.value) }}</span>
                </template>
                <span v-if="recorded(st.id, inp.id).ip?.out_of_tolerance" class="st-badge st-badge--danger" data-test="oot">
                  {{ t('st.quality.record.outOfTolerance') }}
                </span>
                <span v-for="f in recorded(st.id, inp.id).ev?.flags ?? []" :key="f" class="st-badge st-badge--warn">{{ t(`st.quality.record.flags.${f}`) }}</span>
              </td>
              <td class="st-mono">{{ limits(inp) }}</td>
              <td>
                <template v-if="recorded(st.id, inp.id).ev">
                  {{ registry.userName(recorded(st.id, inp.id).ev!.actor_id) }}
                  <span class="st-hint">· {{ t(`st.quality.record.sources.${recorded(st.id, inp.id).ev!.payload.source}`) }}</span><br />
                  <span class="st-hint">{{ fmtDateTime(recorded(st.id, inp.id).ev!.client_ts, locale) }}</span>
                </template>
                <span v-else class="st-muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </article>
    </section>
  </div>
</template>

<style scoped>
.st-rsteps__sec { display: flex; flex-direction: column; gap: 8px; }
.st-rsteps__step { break-inside: avoid; padding: 12px; }
.st-rsteps__num { color: var(--st-text-muted); }
.st-rsteps__sig { margin: 6px 0 0; }
.st-rsteps__inputs { margin-top: 8px; }
.st-rsteps__value { font-size: 1.1rem; font-weight: 700; }
.st-rsteps__photos { display: flex; flex-wrap: wrap; gap: 6px; }
@media print {
  .st-rsteps__photos :deep(.st-blob__img) { width: 30mm; height: 30mm; }
}
</style>
