<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { CheckInput } from '../../../domain/types'
import FieldFrame from './FieldFrame.vue'
import RecordedMeta from './RecordedMeta.vue'
import { useField, type FieldProps } from './useField'

const props = defineProps<FieldProps<CheckInput>>()
const { t } = useI18n()
const f = useField(props)
const { busy, errors, currentEvent, history, hasValue } = f
</script>

<template>
  <FieldFrame :input="input" :errors="errors" :tone="hasValue ? 'ok' : null">
    <p v-if="hasValue" class="st-check__done" data-test="check-done">
      <span aria-hidden="true">✓</span> {{ t('st.run.check.done') }}
    </p>
    <RecordedMeta :event="currentEvent" :history="history" />
    <button
      v-if="!hasValue && editable"
      type="button"
      class="st-btn st-btn--lg st-btn--block st-check__btn"
      :disabled="busy"
      data-test="check-confirm"
      @click="f.record(true, 'manual')"
    >
      <span class="st-check__box" aria-hidden="true" /> {{ t('st.run.check.confirm') }}
    </button>
    <p v-else-if="!hasValue" class="st-muted">{{ t('st.run.value.none') }}</p>
  </FieldFrame>
</template>

<style scoped>
.st-check__done { margin: 0; font-size: 1.3rem; font-weight: 700; color: var(--st-ok); }
.st-check__btn { justify-content: flex-start; }
.st-check__box { width: 32px; height: 32px; border: 3px solid currentColor; border-radius: 6px; flex: none; }
</style>
