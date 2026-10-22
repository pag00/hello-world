<script setup lang="ts">
// Modal dialog. Teleports to <body> but re-applies .st-root so tokens/styles keep working when embedded.
import { onBeforeUnmount, onMounted } from 'vue'

const props = withDefaults(defineProps<{ open: boolean; title?: string; dismissible?: boolean }>(), { dismissible: true })
const emit = defineEmits<{ close: [] }>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open && props.dismissible) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="st-root">
      <div class="st-dialog-backdrop" @click.self="dismissible && emit('close')">
        <div class="st-dialog st-card st-stack" role="dialog" aria-modal="true" :aria-label="title">
          <h2 v-if="title" class="st-h2">{{ title }}</h2>
          <slot />
          <div v-if="$slots.actions" class="st-row" style="justify-content: flex-end">
            <slot name="actions" />
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
