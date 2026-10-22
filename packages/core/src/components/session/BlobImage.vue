<script setup lang="ts">
// CONTRACT (core-data workstream implements): renders an image from a "sha256:<hex>" ref via useBlobStore().url().
defineProps<{ refId: string; alt?: string; thumb?: boolean }>()
</script>

<template>
  <span class="st-badge">img</span>
</template>
