<script setup lang="ts">
// Summary of all content issues; tapping one opens the step it belongs to.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RevisionContent } from '../../domain/types'
import { stepNumbers } from './contentOps'
import { ISSUE_PREFIX, type Issue } from './validation'

const props = defineProps<{ issues: Issue[]; content: RevisionContent }>()
const emit = defineEmits<{ focus: [stepId: string] }>()
const { t } = useI18n()

const numbers = computed(() => stepNumbers(props.content))
const order = { error: 0, incomplete: 1, warning: 2 } as const
const sorted = computed(() => [...props.issues].sort((a, b) => order[a.severity] - order[b.severity]))
const tone = (i: Issue) => (i.severity === 'error' ? 'st-badge--danger' : i.severity === 'incomplete' ? 'st-badge--warn' : '')
</script>

<template>
  <ul v-if="sorted.length" class="st-issues" data-test="issue-list">
    <li v-for="(i, n) in sorted" :key="n" class="st-issues__item">
      <span class="st-badge" :class="tone(i)">{{ t(`st.authoring.severity.${i.severity}`) }}</span>
      <button v-if="i.stepId" type="button" class="st-btn st-btn--ghost st-issues__link" @click="emit('focus', i.stepId!)">
        <span class="st-mono">{{ numbers.get(i.stepId) ?? '?' }}</span>
        {{ t(ISSUE_PREFIX + i.key, i.params ?? {}) }}
      </button>
      <span v-else>{{ t(ISSUE_PREFIX + i.key, i.params ?? {}) }}</span>
    </li>
  </ul>
</template>

<style scoped>
.st-issues { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.st-issues__item { display: flex; align-items: center; gap: 8px; }
.st-issues__link { justify-content: flex-start; text-align: left; font-weight: 500; padding: 0 8px; gap: 8px; }
</style>
