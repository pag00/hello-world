<script setup lang="ts">
// Markdown instructions with a preview rendered exactly like the shop-floor step view (same sanitizer).
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '../run/markdown'

const model = defineModel<string>({ required: true })
defineProps<{ id: string; readonly?: boolean }>()
const { t } = useI18n()
const mode = ref<'edit' | 'preview'>('edit')
const html = computed(() => renderMarkdown(model.value))
</script>

<template>
  <div class="st-md">
    <div class="st-md__tabs" role="tablist">
      <button
        v-if="!readonly"
        type="button"
        role="tab"
        class="st-btn st-btn--ghost"
        :aria-selected="mode === 'edit'"
        :class="{ 'st-md__tab--on': mode === 'edit' }"
        @click="mode = 'edit'"
      >
        {{ t('st.authoring.editor.write') }}
      </button>
      <button
        v-if="!readonly"
        type="button"
        role="tab"
        class="st-btn st-btn--ghost"
        :aria-selected="mode === 'preview'"
        :class="{ 'st-md__tab--on': mode === 'preview' }"
        data-test="md-preview"
        @click="mode = 'preview'"
      >
        {{ t('st.authoring.editor.preview') }}
      </button>
    </div>
    <textarea
      v-if="mode === 'edit' && !readonly"
      :id="id"
      v-model="model"
      class="st-textarea st-md__src st-mono"
      rows="6"
      :placeholder="t('st.authoring.editor.instructionsPlaceholder')"
    />
    <!-- eslint-disable-next-line vue/no-v-html -- sanitized by renderMarkdown (DOMPurify) -->
    <div v-else-if="html" class="st-md__preview" data-test="md-html" v-html="html" />
    <p v-else class="st-muted">{{ t('st.authoring.editor.noInstructions') }}</p>
  </div>
</template>

<style scoped>
.st-md__tabs { display: flex; gap: 4px; margin-bottom: 6px; }
.st-md__tab--on { background: var(--st-surface-2); color: var(--st-primary); }
.st-md__src { resize: vertical; font-size: 0.95rem; }
.st-md__preview {
  padding: 10px 12px; border: 1px solid var(--st-border); border-radius: var(--st-radius);
  background: var(--st-surface); min-height: var(--st-touch); overflow-wrap: anywhere;
}
.st-md__preview :deep(img) { max-width: 100%; }
</style>
