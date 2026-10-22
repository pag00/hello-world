<script setup lang="ts">
// CONTRACT (device workstream implements): captures a photo of a display, runs numeric OCR,
// lets the operator confirm/correct the value, then emits it. Operator confirmation is mandatory.
defineProps<{ decimals?: number; unit?: string; disabled?: boolean }>()
defineEmits<{ read: [result: { value: string; raw: string; confidence: number }]; error: [message: string] }>()
</script>

<template>
  <button class="st-btn" type="button" :disabled="disabled">OCR</button>
</template>
