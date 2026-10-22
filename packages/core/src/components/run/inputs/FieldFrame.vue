<script setup lang="ts">
// Common chrome of one input on the step screen: label, required marker, errors.
import { useI18n } from 'vue-i18n'
import type { Input } from '../../../domain/types'

defineProps<{ input: Input; errors?: string[]; tone?: 'ok' | 'warn' | 'danger' | null }>()
const { t } = useI18n()
</script>

<template>
  <section class="st-field" :class="tone ? `st-field--${tone}` : null" :data-input-id="input.id" :data-input-type="input.type">
    <header class="st-field__head">
      <h3 class="st-field__label">{{ input.label }}</h3>
      <span v-if="input.required" class="st-badge">{{ t('st.common.required') }}</span>
      <span v-else class="st-badge">{{ t('st.common.optional') }}</span>
      <slot name="head" />
    </header>
    <slot />
    <p v-for="e in errors ?? []" :key="e" class="st-alert st-alert--danger" role="alert" data-test="field-error">{{ e }}</p>
  </section>
</template>

<style scoped>
.st-field {
  display: flex; flex-direction: column; gap: 10px; padding: 14px;
  border: 1px solid var(--st-border); border-left-width: 6px; border-radius: var(--st-radius); background: var(--st-surface);
}
.st-field--ok { border-left-color: var(--st-ok); }
.st-field--warn { border-left-color: var(--st-warn); }
.st-field--danger { border-left-color: var(--st-danger); }
.st-field__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.st-field__label { margin: 0; font-size: 1.1rem; flex: 1; min-width: 12ch; }
</style>
