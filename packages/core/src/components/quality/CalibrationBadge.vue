<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Tool } from '../../domain/types'
import { calibrationStatus, type CalibrationStatus } from './calibration'

const props = defineProps<{ tool: Pick<Tool, 'calibration_due'>; today?: Date }>()
const { t } = useI18n()

const TONE: Record<CalibrationStatus, string> = {
  ok: 'st-badge--ok',
  due_soon: 'st-badge--warn',
  expired: 'st-badge--danger',
  not_required: '',
}
const s = computed(() => calibrationStatus(props.tool, props.today))
const text = computed(() => {
  const { status, days } = s.value
  if (status === 'due_soon') return days === 0 ? t('st.quality.calibration.dueToday') : t('st.quality.calibration.dueIn', { n: days ?? 0 }, days ?? 0)
  return t(`st.quality.calibration.${status}`)
})
</script>

<template>
  <span class="st-badge" :class="TONE[s.status]" :data-status="s.status">{{ text }}</span>
</template>
