<script setup lang="ts">
// Photo evidence. Each capture is stored locally (content-addressed) and recorded right away, so a photo
// is never lost if the tablet is put down. Adding a photo supersedes the previous list with a superset
// (nothing is lost, no reason needed); removing photos is a correction and needs a reason.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PhotoInput, Sha256Ref } from '../../../domain/types'
import { useBlobStore } from '../../../stores'
import PhotoCaptureButton from '../../device/PhotoCaptureButton.vue'
import BlobImage from '../../session/BlobImage.vue'
import { deviceErrorText, errorLines } from '../errors'
import CorrectionReason from './CorrectionReason.vue'
import FieldFrame from './FieldFrame.vue'
import RecordedMeta from './RecordedMeta.vue'
import { useField, type FieldProps } from './useField'

const props = defineProps<FieldProps<PhotoInput>>()
const { t } = useI18n()
const blobs = useBlobStore()
const f = useField(props)
const { busy, errors, currentEvent, history, correcting, reason } = f

const storing = ref(false)
const removed = ref<Set<Sha256Ref>>(new Set())

const photos = computed<Sha256Ref[]>(() => (Array.isArray(props.state?.value) ? props.state.value : []))
const minCount = computed(() => Math.max(props.input.required ? 1 : 0, props.input.min_count ?? 0))
const maxCount = computed(() => props.input.max_count ?? null)
const full = computed(() => maxCount.value !== null && photos.value.length >= maxCount.value)
const enough = computed(() => photos.value.length >= minCount.value)
const remaining = computed(() => photos.value.filter((p) => !removed.value.has(p)))

const countText = computed(() =>
  maxCount.value !== null
    ? t('st.run.photo.countMinMax', { n: photos.value.length, min: minCount.value, max: maxCount.value })
    : t('st.run.photo.countMin', { n: photos.value.length, min: minCount.value }),
)

async function onCaptured(blob: Blob) {
  if (full.value || busy.value || storing.value) return
  storing.value = true
  errors.value = []
  try {
    const blobRef = await blobs.put(blob)
    if (photos.value.includes(blobRef)) {
      errors.value = [t('st.run.photo.duplicate')]
      return
    }
    await f.record([...photos.value, blobRef], 'manual', { additive: true })
  } catch (e) {
    errors.value = errorLines(e, t)
  } finally {
    storing.value = false
  }
}

function onDeviceError(m: string) {
  errors.value = [deviceErrorText(m, t)]
}

function toggleRemove(p: Sha256Ref) {
  const next = new Set(removed.value)
  if (next.has(p)) next.delete(p)
  else next.add(p)
  removed.value = next
}

function begin() {
  removed.value = new Set()
  f.startCorrection()
}

function cancel() {
  removed.value = new Set()
  f.cancelCorrection()
}

async function saveRemoval() {
  if (!removed.value.size || !remaining.value.length) return
  if (await f.record(remaining.value, 'manual')) removed.value = new Set()
}
</script>

<template>
  <FieldFrame :input="input" :errors="errors" :tone="enough && photos.length ? 'ok' : null">
    <template #head>
      <span class="st-badge" :class="enough ? 'st-badge--ok' : 'st-badge--warn'" data-test="photo-count">{{ countText }}</span>
    </template>

    <ul v-if="photos.length" class="st-photo__grid">
      <li v-for="p in photos" :key="p" class="st-photo__item" :class="{ 'st-photo__item--removed': removed.has(p) }">
        <BlobImage :ref-id="p" :alt="input.label" thumb />
        <button
          v-if="correcting"
          type="button"
          class="st-btn st-photo__remove"
          :aria-pressed="removed.has(p)"
          data-test="photo-remove"
          @click="toggleRemove(p)"
        >
          {{ removed.has(p) ? t('st.run.photo.keep') : t('st.run.photo.remove') }}
        </button>
      </li>
    </ul>
    <p v-else-if="!editable" class="st-muted">{{ t('st.run.value.none') }}</p>
    <RecordedMeta :event="currentEvent" :history="history" />

    <template v-if="editable">
      <div v-if="!correcting" class="st-row">
        <PhotoCaptureButton
          :label="photos.length ? t('st.run.photo.addAnother') : t('st.run.photo.take')"
          :disabled="full || busy || storing"
          @captured="onCaptured"
          @error="onDeviceError"
        />
        <span v-if="full" class="st-hint">{{ t('st.run.photo.full') }}</span>
        <span v-if="storing || busy" class="st-hint" aria-live="polite">{{ t('st.run.photo.saving') }}</span>
        <span class="st-spacer" />
        <button v-if="photos.length > 1" type="button" class="st-btn" data-test="correct" @click="begin">{{ t('st.run.photo.removeSome') }}</button>
      </div>
      <template v-else>
        <p class="st-hint">{{ t('st.run.photo.removeHint') }}</p>
        <CorrectionReason v-model="reason" @cancel="cancel" />
        <div>
          <button
            type="button"
            class="st-btn st-btn--primary"
            :disabled="busy || !removed.size || !remaining.length"
            data-test="record"
            @click="saveRemoval"
          >
            {{ t('st.run.photo.saveRemoval', { n: removed.size }) }}
          </button>
        </div>
      </template>
    </template>
  </FieldFrame>
</template>

<style scoped>
.st-photo__grid { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px; }
.st-photo__item { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
.st-photo__item--removed { opacity: 0.4; }
.st-photo__remove { min-height: 40px; }
</style>
