<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RunStatus } from '../../domain/types'

const props = defineProps<{ status: RunStatus }>()
const { t } = useI18n()

const TONE: Record<RunStatus, string> = {
  active: 'st-badge--info',
  blocked: 'st-badge--warn',
  completed: 'st-badge--ok',
  aborted: 'st-badge--danger',
}
const tone = computed(() => TONE[props.status])
</script>

<template>
  <span class="st-badge" :class="tone" :data-status="status">{{ t(`st.run.status.${status}`) }}</span>
</template>
