<script setup lang="ts">
// Photo of a display → numeric OCR → operator review. Nothing is ever accepted automatically: the dialog
// shows the photo, the parsed value (editable) and the alternative readings, and only an explicit
// confirmation emits `read`. When no reading exists the operator is sent back to manual entry instead,
// so a typed value is never labelled as an OCR reading.
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { ocrAvailable, useDevice } from '../../device'
import { errorMessage } from '../../device/errors'
import type { OcrResult } from '../../device/types'
import { compareDecimal, parseDecimal, toFixedDecimals } from '../../domain/decimal'
import StDialog from '../StDialog.vue'

// two root nodes (button group + teleported dialog): attrs belong on the button group
defineOptions({ name: 'OcrCaptureButton', inheritAttrs: false })

const props = defineProps<{ decimals?: number; unit?: string; disabled?: boolean }>()
const emit = defineEmits<{ read: [result: { value: string; raw: string; confidence: number }]; error: [message: string] }>()

const { t } = useI18n()
const device = useDevice()
const uid = useId()

type Phase = 'closed' | 'reading' | 'review' | 'none' | 'failed'
const phase = ref<Phase>('closed')
const available = ref<boolean | null>(null)
const capturing = ref(false)
const photoUrl = ref<string | null>(null)
const result = ref<OcrResult | null>(null)
const failure = ref<string | null>(null)
const draft = ref('')
let job = 0

onMounted(async () => {
  available.value = await ocrAvailable(device.ocr)
})

function setPhoto(blob: Blob | null) {
  if (photoUrl.value) URL.revokeObjectURL(photoUrl.value)
  photoUrl.value = blob ? URL.createObjectURL(blob) : null
}

function close() {
  job++
  phase.value = 'closed'
  result.value = null
  failure.value = null
  draft.value = ''
  setPhoto(null)
}
onBeforeUnmount(close)

async function capture() {
  if (props.disabled || capturing.value || available.value === false) return
  capturing.value = true
  const mine = ++job
  let photo: Blob | null
  try {
    // first statement: the web camera needs the click's user activation to open the picker
    photo = await device.camera.capturePhoto()
  } catch (e) {
    capturing.value = false
    emit('error', errorMessage(e, 'cameraFailed'))
    return
  }
  capturing.value = false
  if (!photo || mine !== job) return
  setPhoto(photo)
  result.value = null
  failure.value = null
  phase.value = 'reading'
  try {
    // `unit` goes beyond the OcrAdapter contract; adapters that understand it strip it more reliably
    const opts: { decimals?: number; unit?: string } = { decimals: props.decimals, unit: props.unit }
    const r = await device.ocr.recognizeNumber(photo, opts)
    if (mine !== job) return
    result.value = r
    draft.value = r.value ?? ''
    phase.value = r.value === null ? 'none' : 'review'
  } catch (e) {
    if (mine !== job) return
    failure.value = errorMessage(e, 'ocrFailed')
    phase.value = 'failed'
  }
}

const normalizedDraft = computed(() => draft.value.trim().replace(',', '.'))

const validation = computed<{ ok: true; value: string } | { ok: false; message: string }>(() => {
  const s = normalizedDraft.value
  if (!s || !parseDecimal(s)) return { ok: false, message: t('st.device.ocr.invalid') }
  if (props.decimals !== undefined) {
    const r = toFixedDecimals(s, props.decimals)
    if (!r.ok) {
      return {
        ok: false,
        message: r.error === 'too_many_decimals' ? t('st.device.ocr.tooManyDecimals', { n: props.decimals }) : t('st.device.ocr.invalid'),
      }
    }
    return { ok: true, value: r.value }
  }
  return { ok: true, value: s }
})

/** the operator typed something no OCR reading supports: allowed, but flagged so they look twice */
const edited = computed(() => {
  const v = validation.value
  if (!v.ok || !result.value) return false
  return !result.value.candidates.some((c) => {
    try {
      return compareDecimal(c, v.value) === 0
    } catch {
      return false
    }
  })
})

const pct = computed(() => Math.round((result.value?.confidence ?? 0) * 100))
const lowConfidence = computed(() => (result.value?.confidence ?? 0) < 0.6)

function confirm() {
  const v = validation.value
  if (!v.ok || !result.value) return
  emit('read', { value: v.value, raw: result.value.raw, confidence: result.value.confidence })
  close()
}
</script>

<template>
  <span v-bind="$attrs" class="st-ocrbtn">
    <button
      class="st-btn"
      type="button"
      :disabled="disabled || capturing || available === false"
      :aria-busy="capturing"
      :aria-describedby="available === false ? `${uid}-unavailable` : undefined"
      data-test="ocr-button"
      @click="capture"
    >
      <svg class="st-ocrbtn__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M3 3h5v2H5v3H3V3zm13 0h5v5h-2V5h-3V3zM3 16h2v3h3v2H3v-5zm16 3v-3h2v5h-5v-2h3zM7 9h2v6H7V9zm4 0h2v6h-2V9zm4 0h2v6h-2V9z" fill="currentColor" />
      </svg>
      <span>{{ t('st.device.ocr.button') }}</span>
    </button>
    <span v-if="available === false" :id="`${uid}-unavailable`" class="st-hint" data-test="ocr-unavailable">{{ t('st.device.ocr.unavailable') }}</span>
  </span>

  <StDialog :open="phase !== 'closed'" :title="t('st.device.ocr.title')" :dismissible="phase !== 'review'" @close="close">
    <img v-if="photoUrl" :src="photoUrl" :alt="t('st.device.ocr.photoAlt')" class="st-ocrbtn__photo" data-test="ocr-photo" />

    <p v-if="phase === 'reading'" class="st-alert st-alert--info" aria-live="polite">{{ t('st.device.ocr.reading') }}</p>

    <template v-else-if="phase === 'review' && result">
      <label class="st-label" :for="`${uid}-value`">{{ t('st.device.ocr.value') }}<template v-if="unit"> ({{ unit }})</template></label>
      <input
        :id="`${uid}-value`"
        v-model="draft"
        class="st-input st-input--num"
        inputmode="decimal"
        autocomplete="off"
        data-test="ocr-value"
        @keydown.enter="confirm"
      />
      <p class="st-hint">{{ t('st.device.ocr.valueHint') }}</p>
      <p v-if="!validation.ok" class="st-alert st-alert--danger" role="alert">{{ validation.message }}</p>
      <p v-else-if="edited" class="st-alert st-alert--warn" role="status" data-test="ocr-edited">{{ t('st.device.ocr.edited') }}</p>

      <div v-if="result.candidates.length > 1" class="st-stack">
        <span class="st-label">{{ t('st.device.ocr.candidates') }}</span>
        <div class="st-row">
          <button
            v-for="c in result.candidates"
            :key="c"
            type="button"
            class="st-btn st-mono st-ocrbtn__cand"
            :aria-pressed="normalizedDraft === c"
            :data-test="`ocr-candidate-${c}`"
            @click="draft = c"
          >
            {{ c }}
          </button>
        </div>
      </div>

      <div class="st-row st-hint">
        <span>{{ t('st.device.ocr.raw') }}: <code class="st-mono" data-test="ocr-raw">{{ result.raw || '—' }}</code></span>
        <span class="st-badge" :class="lowConfidence ? 'st-badge--warn' : 'st-badge--ok'">{{ t('st.device.ocr.confidence', { pct }) }}</span>
      </div>
      <p v-if="lowConfidence" class="st-alert st-alert--warn">{{ t('st.device.ocr.lowConfidence') }}</p>
    </template>

    <p v-else-if="phase === 'none'" class="st-alert st-alert--warn" role="status" data-test="ocr-none">
      {{ t('st.device.ocr.noReading') }}
      <template v-if="result?.raw"><br /><span class="st-hint">{{ t('st.device.ocr.raw') }}: <code class="st-mono">{{ result.raw }}</code></span></template>
    </p>
    <p v-else-if="phase === 'failed'" class="st-alert st-alert--danger" role="alert" data-test="ocr-failed">
      {{ failure === 'st.device.errors.ocrUnavailable' ? t('st.device.ocr.unavailable') : t('st.device.ocr.failed') }}
    </p>

    <template #actions>
      <button type="button" class="st-btn" data-test="ocr-cancel" @click="close">{{ t('st.common.cancel') }}</button>
      <button v-if="phase !== 'reading'" type="button" class="st-btn" data-test="ocr-retake" @click="capture">{{ t('st.device.ocr.retake') }}</button>
      <button
        v-if="phase === 'review'"
        type="button"
        class="st-btn st-btn--primary"
        :disabled="!validation.ok"
        data-test="ocr-confirm"
        @click="confirm"
      >
        {{ t('st.device.ocr.confirm') }}
      </button>
    </template>
  </StDialog>
</template>

<style scoped>
.st-ocrbtn { display: inline-flex; flex-direction: column; gap: 4px; }
.st-ocrbtn__icon { width: 1.3em; height: 1.3em; flex: none; }
.st-ocrbtn__photo {
  display: block; width: 100%; max-height: 38vh; object-fit: contain;
  background: #000; border-radius: var(--st-radius);
}
.st-ocrbtn__cand { min-width: 96px; font-size: 1.2rem; }
.st-ocrbtn__cand[aria-pressed='true'] { border-color: var(--st-primary); box-shadow: inset 0 0 0 2px var(--st-primary); }
</style>
