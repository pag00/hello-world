<script setup lang="ts">
// Raise an NCR for the run, a step, or one input of a step. Works offline (the number is assigned by the
// server on sync); the description is prefilled when raised from an out-of-tolerance value or expired tool.
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Uuid } from '../../domain/types'
import { useRunsStore } from '../../stores'
import StDialog from '../StDialog.vue'
import { errorLines } from './errors'

const props = defineProps<{ open: boolean; runId: Uuid; stepId: Uuid | null; inputId?: Uuid | null; prefill?: string; context?: string }>()
const emit = defineEmits<{ close: []; raised: [] }>()
const { t } = useI18n()
const runs = useRunsStore()

const description = ref('')
const busy = ref(false)
const errors = ref<string[]>([])

watch(
  () => props.open,
  (o) => {
    if (o) {
      description.value = props.prefill ?? ''
      errors.value = []
    }
  },
  { immediate: true },
)

async function submit() {
  if (!description.value.trim() || busy.value) return
  busy.value = true
  errors.value = []
  try {
    await runs.raiseNcr({ runId: props.runId, stepId: props.stepId, inputId: props.inputId ?? null, description: description.value })
    emit('raised')
    emit('close')
  } catch (e) {
    errors.value = errorLines(e, t)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <StDialog :open="open" :title="t('st.run.ncr.raiseTitle')" @close="emit('close')">
    <p v-if="context" class="st-hint">{{ context }}</p>
    <label class="st-stack">
      <span class="st-label">{{ t('st.run.ncr.description') }}</span>
      <textarea v-model="description" class="st-textarea" rows="4" data-test="ncr-description" />
    </label>
    <p class="st-hint">{{ t('st.run.ncr.numberLater') }}</p>
    <p v-for="e in errors" :key="e" class="st-alert st-alert--danger" role="alert">{{ e }}</p>
    <template #actions>
      <button type="button" class="st-btn" @click="emit('close')">{{ t('st.common.cancel') }}</button>
      <button type="button" class="st-btn st-btn--danger" :disabled="!description.trim() || busy" data-test="ncr-submit" @click="submit">
        {{ t('st.run.ncr.raise') }}
      </button>
    </template>
  </StDialog>
</template>
