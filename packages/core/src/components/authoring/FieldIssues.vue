<script setup lang="ts">
// Messages for one field (or one object when field is omitted), right under the control they concern.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ISSUE_PREFIX, type Issue } from './validation'

const props = defineProps<{ issues: Issue[]; field?: string; exact?: boolean }>()
const { t } = useI18n()
const shown = computed(() => props.issues.filter((i) => (props.field === undefined ? !props.exact || !i.field : i.field === props.field)))
</script>

<template>
  <ul v-if="shown.length" class="st-field-issues">
    <li
      v-for="(i, n) in shown"
      :key="n"
      :class="i.severity === 'warning' ? 'st-field-issues--warn' : 'st-field-issues--error'"
      :data-issue="i.key"
    >
      {{ t(ISSUE_PREFIX + i.key, i.params ?? {}) }}
    </li>
  </ul>
</template>

<style scoped>
.st-field-issues { list-style: none; margin: 4px 0 0; padding: 0; font-size: 0.9rem; font-weight: 600; }
.st-field-issues--error { color: var(--st-danger); }
.st-field-issues--warn { color: var(--st-warn); }
</style>
