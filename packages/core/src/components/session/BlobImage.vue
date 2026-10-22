<script setup lang="ts">
// Renders an image from a "sha256:<hex>" ref via useBlobStore().url() (local cache first, server when online).
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBlobStore } from '../../stores'

const props = defineProps<{ refId: string; alt?: string; thumb?: boolean }>()
const { t } = useI18n()
const blobs = useBlobStore()
const src = ref<string | null>(null)
const state = ref<'loading' | 'ok' | 'missing'>('loading')

let token = 0
watch(
  () => props.refId,
  async (refId) => {
    const mine = ++token
    state.value = 'loading'
    src.value = null
    const url = await blobs.url(refId).catch(() => null)
    if (mine !== token) return
    src.value = url
    state.value = url ? 'ok' : 'missing'
  },
  { immediate: true },
)
</script>

<template>
  <span class="st-blob" :class="{ 'st-blob--thumb': thumb }">
    <img v-if="state === 'ok' && src" :src="src" :alt="alt ?? ''" class="st-blob__img" loading="lazy" @error="state = 'missing'" />
    <span v-else class="st-blob__placeholder st-muted" role="img" :aria-label="alt ?? t(state === 'loading' ? 'st.session.blob.loading' : 'st.session.blob.missing')">
      {{ state === 'loading' ? t('st.session.blob.loading') : t('st.session.blob.missing') }}
    </span>
  </span>
</template>

<style scoped>
.st-blob { display: inline-block; max-width: 100%; }
.st-blob__img { display: block; max-width: 100%; height: auto; border-radius: var(--st-radius); border: 1px solid var(--st-border); }
.st-blob--thumb .st-blob__img, .st-blob--thumb .st-blob__placeholder { width: 120px; height: 120px; object-fit: cover; }
.st-blob__placeholder {
  display: flex; align-items: center; justify-content: center; text-align: center; padding: 8px;
  min-width: 120px; min-height: 120px; font-size: 0.85rem;
  background: var(--st-surface-2); border: 1px dashed var(--st-border); border-radius: var(--st-radius);
}
</style>
