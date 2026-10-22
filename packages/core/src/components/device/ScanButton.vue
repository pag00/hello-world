<script setup lang="ts">
// CONTRACT (device workstream implements): button that opens the scanner (native or web overlay)
// and emits the scanned text once. `expect` (exact or /regex/) is only a hint for UI feedback.
defineProps<{ label?: string; expect?: string | null; disabled?: boolean; size?: 'md' | 'lg' }>()
defineEmits<{ scanned: [text: string]; error: [message: string] }>()
</script>

<template>
  <button class="st-btn" type="button" :disabled="disabled">{{ label ?? 'Scan' }}</button>
</template>
