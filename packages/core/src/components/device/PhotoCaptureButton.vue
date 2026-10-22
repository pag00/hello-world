<script setup lang="ts">
// Captures one compressed JPEG (long edge ≤ 2048 px, EXIF/GPS stripped) and emits the Blob.
// Callers store it via useBlobStore().put(blob).
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDevice } from '../../device'
import { errorMessage } from '../../device/errors'

defineOptions({ name: 'PhotoCaptureButton' })

const props = defineProps<{ label?: string; disabled?: boolean }>()
const emit = defineEmits<{ captured: [photo: Blob]; error: [message: string] }>()

const { t } = useI18n()
const device = useDevice()
const busy = ref(false)

async function capture() {
  if (props.disabled || busy.value) return
  busy.value = true
  try {
    // no await before this call: the web adapter opens a file picker, which needs the click's user activation
    const photo = await device.camera.capturePhoto()
    if (photo) emit('captured', photo)
  } catch (e) {
    emit('error', errorMessage(e, 'cameraFailed'))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <button class="st-btn" type="button" :disabled="disabled || busy" :aria-busy="busy" data-test="photo-button" @click="capture">
    <svg class="st-photobtn__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"
        fill="currentColor"
      />
    </svg>
    <span>{{ busy ? t('st.device.photo.processing') : (label ?? t('st.device.photo.button')) }}</span>
  </button>
</template>

<style scoped>
.st-photobtn__icon { width: 1.3em; height: 1.3em; flex: none; }
</style>
