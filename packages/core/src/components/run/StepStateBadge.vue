<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { StepState } from '../../domain/types'

const props = defineProps<{ state: StepState }>()
const { t } = useI18n()

const TONE: Record<StepState, string> = {
  pending: '',
  in_progress: 'st-badge--info',
  blocked: 'st-badge--warn',
  completed: 'st-badge--ok',
  verified: 'st-badge--ok',
  conflict: 'st-badge--danger',
}
const tone = computed(() => TONE[props.state])
</script>

<template>
  <span class="st-badge" :class="tone" :data-state="state">{{ t(`st.run.stepState.${state}`) }}</span>
</template>
