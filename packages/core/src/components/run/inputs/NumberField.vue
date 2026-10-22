<script setup lang="ts">
// Measured value: big monospace entry, tolerance band, live in/out-of-tolerance feedback, optional OCR.
// Out-of-tolerance values are recorded as measured (never blocked or rounded) and then need an NCR.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NumberInput, Uuid } from '../../../domain/types'
import { useRegistryStore } from '../../../stores'
import OcrCaptureButton from '../../device/OcrCaptureButton.vue'
import { deviceErrorText } from '../errors'
import { barGeometry, evaluateMeasurement, toleranceOf } from '../tolerance'
import CorrectionReason from './CorrectionReason.vue'
import FieldFrame from './FieldFrame.vue'
import RecordedMeta from './RecordedMeta.vue'
import { useField, type FieldProps } from './useField'

const props = defineProps<FieldProps<NumberInput>>()
const emit = defineEmits<{ raiseNcr: [req: { inputId: Uuid; prefill: string }] }>()
const { t } = useI18n()
const registry = useRegistryStore()
const f = useField(props)
const { busy, errors, currentEvent, history, hasValue, showEditor, correcting, reason } = f

const draft = ref('')
const draftSource = ref<'manual' | 'ocr'>('manual')
const ocrRaw = ref<string | undefined>(undefined)

const live = computed(() => evaluateMeasurement(draft.value, props.input))
const recorded = computed(() => (typeof props.state?.value === 'string' ? props.state.value : null))
const recordedTol = computed(() => {
  if (!recorded.value) return null
  // trust the projection's verdict (also covers unparseable values), refine low/high for the message
  if (!props.state?.out_of_tolerance) return 'in'
  try {
    const t2 = toleranceOf(recorded.value, props.input)
    return t2 === 'in' ? 'invalid' : t2
  } catch {
    return 'invalid'
  }
})

const covered = computed(() =>
  registry.ncrs.some((n) => n.run_id === props.runId && n.step_id === props.stepId && (n.input_id == null || n.input_id === props.input.id)),
)

const shownValue = computed(() => (showEditor.value ? live.value.value : recorded.value))
const bar = computed(() => barGeometry(props.input, shownValue.value))

const limitsText = computed(() => {
  const i = props.input
  const parts: string[] = []
  if (i.min != null) parts.push(t('st.run.number.min', { v: i.min }))
  if (i.nominal != null) parts.push(t('st.run.number.nominal', { v: i.nominal }))
  if (i.max != null) parts.push(t('st.run.number.max', { v: i.max }))
  return parts.length ? `${parts.join(' · ')} ${i.unit}` : t('st.run.number.noLimits')
})

const liveTone = computed(() => {
  switch (live.value.state) {
    case 'in': return 'ok'
    case 'low':
    case 'high': return 'danger'
    case 'empty': return null
    default: return 'warn'
  }
})

const frameTone = computed(() => {
  if (showEditor.value) return liveTone.value
  if (!recordedTol.value) return null
  return recordedTol.value === 'in' ? 'ok' : covered.value ? 'warn' : 'danger'
})

function onType(e: Event) {
  draft.value = (e.target as HTMLInputElement).value
  // once the operator edits an OCR reading it is a manual entry
  draftSource.value = 'manual'
  ocrRaw.value = undefined
}

function onOcr(r: { value: string; raw: string; confidence: number }) {
  draft.value = r.value
  draftSource.value = 'ocr'
  ocrRaw.value = r.raw
}

function onDeviceError(m: string) {
  errors.value = [deviceErrorText(m, t)]
}

function begin() {
  draft.value = recorded.value ?? ''
  draftSource.value = 'manual'
  ocrRaw.value = undefined
  f.startCorrection()
}

async function save() {
  const m = live.value
  if (!m.value) return
  const ok = await f.record(m.value, draftSource.value, { ocrRaw: draftSource.value === 'ocr' ? ocrRaw.value : undefined })
  if (ok) {
    draft.value = ''
    draftSource.value = 'manual'
    ocrRaw.value = undefined
  }
}

function raiseNcr() {
  const i = props.input
  emit('raiseNcr', {
    inputId: i.id,
    prefill: t('st.run.number.ncrPrefill', { label: i.label, value: recorded.value ?? '', unit: i.unit, min: i.min ?? '—', max: i.max ?? '—' }),
  })
}
</script>

<template>
  <FieldFrame :input="input" :errors="errors" :tone="frameTone">
    <p class="st-num__limits st-mono" data-test="limits">{{ limitsText }}</p>

    <div v-if="bar" class="st-num__bar" aria-hidden="true" data-test="tolerance-bar">
      <span class="st-num__band" :style="{ left: `${bar.min * 100}%`, width: `${(bar.max - bar.min) * 100}%` }" />
      <span v-if="bar.nominal !== null" class="st-num__nominal" :style="{ left: `${bar.nominal * 100}%` }" />
      <span
        v-if="bar.marker !== null"
        class="st-num__marker"
        :class="{ 'st-num__marker--out': bar.clamped || (showEditor ? liveTone === 'danger' : recordedTol !== 'in') }"
        :style="{ left: `${bar.marker * 100}%` }"
        data-test="tolerance-marker"
      />
    </div>

    <template v-if="hasValue && !correcting">
      <p class="st-num__value st-mono" data-test="number-value">
        {{ recorded }} <span class="st-num__unit">{{ input.unit }}</span>
      </p>
      <p v-if="recordedTol === 'in'" class="st-alert st-alert--ok" data-test="recorded-tolerance">{{ t('st.run.number.state.in') }}</p>
      <div v-else-if="recordedTol" class="st-alert st-alert--danger st-stack" data-test="recorded-tolerance">
        <strong>{{ t(`st.run.number.recorded.${recordedTol}`) }}</strong>
        <span v-if="covered">{{ t('st.run.number.ncrCovered') }}</span>
        <template v-else>
          <span>{{ t('st.run.number.ncrNeeded') }}</span>
          <div><button type="button" class="st-btn st-btn--danger" data-test="raise-ncr" @click="raiseNcr">{{ t('st.run.ncr.raise') }}</button></div>
        </template>
      </div>
    </template>
    <RecordedMeta :event="currentEvent" :history="history" :unit="input.unit" />
    <div v-if="editable && hasValue && !correcting">
      <button type="button" class="st-btn" data-test="correct" @click="begin">{{ t('st.run.correction.start') }}</button>
    </div>

    <template v-if="showEditor">
      <div class="st-num__entry">
        <input
          :value="draft"
          class="st-input st-input--num st-num__input"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          :aria-label="`${input.label} (${input.unit})`"
          :placeholder="(0).toFixed(input.decimals)"
          data-test="number-draft"
          @input="onType"
          @keydown.enter="save"
        />
        <span class="st-num__unit">{{ input.unit }}</span>
        <OcrCaptureButton v-if="input.ocr" :decimals="input.decimals" :unit="input.unit" :disabled="busy" @read="onOcr" @error="onDeviceError" />
      </div>
      <p v-if="draftSource === 'ocr'" class="st-badge st-badge--info st-num__src" data-test="draft-ocr">{{ t('st.run.number.fromOcr') }}</p>
      <p v-if="live.state !== 'empty'" class="st-alert" :class="`st-alert--${liveTone}`" aria-live="polite" data-test="live-tolerance">
        {{ t(`st.run.number.state.${live.state}`, { decimals: input.decimals }) }}
      </p>
      <CorrectionReason v-if="correcting" v-model="reason" @cancel="f.cancelCorrection()" />
      <div>
        <button
          type="button"
          class="st-btn st-btn--lg"
          :class="liveTone === 'danger' ? 'st-btn--danger' : 'st-btn--primary'"
          :disabled="busy || !live.value"
          data-test="record"
          @click="save"
        >
          {{ liveTone === 'danger' ? t('st.run.number.recordOut') : t('st.run.record') }}
        </button>
      </div>
    </template>
    <p v-else-if="!hasValue" class="st-muted">{{ t('st.run.value.none') }}</p>
  </FieldFrame>
</template>

<style scoped>
.st-num__limits { margin: 0; color: var(--st-text-muted); }
.st-num__bar { position: relative; height: 22px; border-radius: 11px; background: var(--st-danger-bg); overflow: visible; }
.st-num__band { position: absolute; top: 0; bottom: 0; background: var(--st-ok-bg); border-left: 2px solid var(--st-ok); border-right: 2px solid var(--st-ok); }
.st-num__nominal { position: absolute; top: 3px; bottom: 3px; width: 2px; margin-left: -1px; background: var(--st-ok); }
.st-num__marker {
  position: absolute; top: -6px; width: 6px; height: 34px; margin-left: -3px; border-radius: 3px;
  background: var(--st-text); box-shadow: 0 0 0 2px var(--st-surface);
}
.st-num__marker--out { background: var(--st-danger); }
.st-num__value { margin: 0; font-size: 2.4rem; font-weight: 700; line-height: 1.1; }
.st-num__unit { font-size: 1.2rem; color: var(--st-text-muted); font-weight: 600; }
.st-num__entry { display: flex; align-items: center; gap: var(--st-gap); flex-wrap: wrap; }
.st-num__input { flex: 1; min-width: 10ch; min-height: 72px; font-size: 2.2rem; font-weight: 700; }
.st-num__src { align-self: flex-start; margin: 0; }
</style>
