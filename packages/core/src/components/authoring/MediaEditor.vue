<script setup lang="ts">
// Reference images of a step: stored as blobs (hash refs) via the blob store, which queues the upload.
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Sha256Ref } from '../../domain/types'
import { useBlobStore } from '../../stores'
import BlobImage from '../session/BlobImage.vue'
import PhotoCaptureButton from '../device/PhotoCaptureButton.vue'

const props = defineProps<{ media: Sha256Ref[]; readonly?: boolean }>()
const { t } = useI18n()
const blobs = useBlobStore()
const busy = ref(false)
const error = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

async function add(files: Blob[]) {
  error.value = null
  busy.value = true
  try {
    for (const f of files) {
      if (f.type && !f.type.startsWith('image/')) {
        error.value = t('st.authoring.editor.mediaNotImage')
        continue
      }
      const ref = await blobs.put(f)
      // the same picture twice adds nothing to the instructions
      if (!props.media.includes(ref)) props.media.push(ref)
    }
  } catch {
    error.value = t('st.authoring.editor.mediaFailed')
  } finally {
    busy.value = false
  }
}

function onFiles(e: Event) {
  const input = e.target as HTMLInputElement
  void add(Array.from(input.files ?? []))
  input.value = ''
}

function onDeviceError(m: string) {
  // device adapters emit either an i18n key or an already translated message
  error.value = /^st\.[\w.]+$/.test(m) ? t(m) : m || t('st.authoring.editor.mediaFailed')
}

function remove(i: number) {
  props.media.splice(i, 1)
}
</script>

<template>
  <div class="st-media st-stack">
    <div v-if="media.length" class="st-media__grid">
      <figure v-for="(m, i) in media" :key="m" class="st-media__item">
        <BlobImage :ref-id="m" thumb :alt="t('st.authoring.editor.mediaAlt', { n: i + 1 })" />
        <button v-if="!readonly" type="button" class="st-btn st-btn--ghost" :aria-label="t('st.authoring.editor.removeMedia', { n: i + 1 })" @click="remove(i)">
          {{ t('st.common.delete') }}
        </button>
      </figure>
    </div>
    <p v-else class="st-muted">{{ t('st.authoring.editor.noMedia') }}</p>
    <div v-if="!readonly" class="st-row">
      <button type="button" class="st-btn" :disabled="busy" data-test="media-file" @click="fileInput?.click()">{{ t('st.authoring.editor.addImage') }}</button>
      <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onFiles" />
      <PhotoCaptureButton :label="t('st.authoring.editor.takePhoto')" :disabled="busy" @captured="(b) => add([b])" @error="onDeviceError" />
      <span v-if="busy" class="st-hint">{{ t('st.common.loading') }}</span>
    </div>
    <p v-if="error" class="st-alert st-alert--danger" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.st-media__grid { display: flex; flex-wrap: wrap; gap: var(--st-gap); }
.st-media__item { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
</style>
