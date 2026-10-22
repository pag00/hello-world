<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { NcrStatus } from '../../domain/types'

const props = defineProps<{ status: NcrStatus }>()
const { t } = useI18n()

const TONE: Record<NcrStatus, string> = {
  open: 'st-badge--danger',
  dispositioned: 'st-badge--warn',
  closed: 'st-badge--ok',
}
const tone = computed(() => TONE[props.status])
</script>

<template>
  <span class="st-badge" :class="tone" :data-status="status">{{ t(`st.quality.ncr.status.${status}`) }}</span>
</template>
