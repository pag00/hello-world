<script setup lang="ts">
// CONTRACT (device workstream implements): captures one compressed JPEG photo and emits the Blob.
// Callers store it via useBlobStore().put(blob).
defineProps<{ label?: string; disabled?: boolean }>()
defineEmits<{ captured: [photo: Blob]; error: [message: string] }>()
</script>

<template>
  <button class="st-btn" type="button" :disabled="disabled">{{ label ?? 'Photo' }}</button>
</template>
