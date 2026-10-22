<script setup lang="ts">
// Confirmation that needs a written reason (abort, reopen, correction, conflict resolution, take-over).
// The reason goes into the permanent record, so an empty one is never accepted.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import StDialog from '../StDialog.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    message?: string
    confirmLabel?: string
    danger?: boolean
    busy?: boolean
    errors?: string[]
    /** some confirmations (lock take-over) need no text */
    reasonRequired?: boolean
    initial?: string
  }>(),
  { reasonRequired: true, errors: () => [] },
)
const emit = defineEmits<{ confirm: [reason: string]; close: [] }>()
const { t } = useI18n()

const reason = ref('')
watch(
  () => props.open,
  (o) => {
    if (o) reason.value = props.initial ?? ''
  },
  { immediate: true },
)
const valid = computed(() => !props.reasonRequired || reason.value.trim() !== '')

function submit() {
  if (valid.value && !props.busy) emit('confirm', reason.value.trim())
}
</script>

<template>
  <StDialog :open="open" :title="title" @close="emit('close')">
    <p v-if="message">{{ message }}</p>
    <label v-if="reasonRequired" class="st-stack">
      <span class="st-label">{{ t('st.run.reason.label') }}</span>
      <textarea v-model="reason" class="st-textarea" rows="3" data-test="reason-input" />
      <span class="st-hint">{{ t('st.run.reason.hint') }}</span>
    </label>
    <p v-for="e in errors" :key="e" class="st-alert st-alert--danger" role="alert">{{ e }}</p>
    <template #actions>
      <button type="button" class="st-btn" @click="emit('close')">{{ t('st.common.cancel') }}</button>
      <button
        type="button"
        class="st-btn"
        :class="danger ? 'st-btn--danger' : 'st-btn--primary'"
        :disabled="!valid || busy"
        data-test="reason-confirm"
        @click="submit"
      >
        {{ confirmLabel ?? t('st.common.confirm') }}
      </button>
    </template>
  </StDialog>
</template>
