<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RevisionStatus } from '../../domain/types'

const props = defineProps<{ status: RevisionStatus }>()
const { t } = useI18n()

const TONE: Record<RevisionStatus, string> = {
  draft: 'st-badge--info',
  in_review: 'st-badge--warn',
  released: 'st-badge--ok',
  obsolete: '',
}
const tone = computed(() => TONE[props.status])
</script>

<template>
  <span class="st-badge" :class="tone" :data-status="status">{{ t(`st.authoring.status.${status}`) }}</span>
</template>
