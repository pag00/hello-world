<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TextInput } from '../../../domain/types'
import CorrectionReason from './CorrectionReason.vue'
import FieldFrame from './FieldFrame.vue'
import RecordedMeta from './RecordedMeta.vue'
import { useField, type FieldProps } from './useField'

const props = defineProps<FieldProps<TextInput>>()
const { t } = useI18n()
const f = useField(props)
const { busy, errors, currentEvent, history, hasValue, showEditor, correcting, reason } = f
const draft = ref('')

function begin() {
  draft.value = typeof props.state?.value === 'string' ? props.state.value : ''
  f.startCorrection()
}

async function save() {
  if (!draft.value.trim()) return
  if (await f.record(draft.value, 'manual')) draft.value = ''
}
</script>

<template>
  <FieldFrame :input="input" :errors="errors" :tone="hasValue ? 'ok' : null">
    <p v-if="hasValue && !correcting" class="st-text__value" data-test="text-value">{{ state?.value }}</p>
    <RecordedMeta :event="currentEvent" :history="history" />
    <div v-if="editable && hasValue && !correcting">
      <button type="button" class="st-btn" data-test="correct" @click="begin">{{ t('st.run.correction.start') }}</button>
    </div>
    <template v-if="showEditor">
      <textarea v-if="input.multiline" v-model="draft" class="st-textarea" rows="4" :aria-label="input.label" data-test="text-draft" />
      <input v-else v-model="draft" class="st-input" type="text" :aria-label="input.label" data-test="text-draft" />
      <CorrectionReason v-if="correcting" v-model="reason" @cancel="f.cancelCorrection()" />
      <div>
        <button type="button" class="st-btn st-btn--primary" :disabled="busy || !draft.trim()" data-test="record" @click="save">
          {{ t('st.run.record') }}
        </button>
      </div>
    </template>
    <p v-else-if="!hasValue" class="st-muted">{{ t('st.run.value.none') }}</p>
  </FieldFrame>
</template>

<style scoped>
.st-text__value { margin: 0; font-size: 1.15rem; white-space: pre-wrap; word-break: break-word; }
</style>
