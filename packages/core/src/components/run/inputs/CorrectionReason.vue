<script setup lang="ts">
// Reason entry shown while a recorded value is being corrected; it is written to the record as a note.
import { useI18n } from 'vue-i18n'

const reason = defineModel<string>({ required: true })
const emit = defineEmits<{ cancel: [] }>()
const { t } = useI18n()
</script>

<template>
  <div class="st-correction st-stack">
    <p class="st-alert st-alert--info">{{ t('st.run.correction.explain') }}</p>
    <label class="st-stack">
      <span class="st-label">{{ t('st.run.correction.reason') }}</span>
      <input v-model="reason" class="st-input" type="text" data-test="correction-reason" />
    </label>
    <div>
      <button type="button" class="st-btn" data-test="correction-cancel" @click="emit('cancel')">{{ t('st.run.correction.cancel') }}</button>
    </div>
  </div>
</template>
