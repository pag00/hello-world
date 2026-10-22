<script setup lang="ts">
// Printable sheet of QR labels (tools, workstations). On screen it is a preview grid; in print it is a
// plain A4 grid of fixed-size labels, everything else on the page being .st-noprint.
import QrCode from '../QrCode.vue'
import type { Label } from './labels'

defineProps<{ labels: Label[] }>()
</script>

<template>
  <div class="st-labels" data-test="label-sheet">
    <div v-for="l in labels" :key="l.key" class="st-labels__label">
      <QrCode :value="l.url" size="30mm" :label="l.title" />
      <div class="st-labels__text">
        <div class="st-labels__title st-mono">{{ l.title }}</div>
        <div v-if="l.subtitle" class="st-labels__sub">{{ l.subtitle }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.st-labels { display: grid; grid-template-columns: repeat(auto-fill, minmax(62mm, 1fr)); gap: 4mm; }
.st-labels__label {
  display: flex; align-items: center; gap: 3mm; padding: 3mm; min-height: 36mm;
  border: 1px dashed var(--st-border); border-radius: 4px; background: #fff; color: #000;
  break-inside: avoid; page-break-inside: avoid;
}
.st-labels__text { min-width: 0; }
.st-labels__title { font-size: 1.3rem; font-weight: 700; word-break: break-all; }
.st-labels__sub { font-size: 0.85rem; overflow-wrap: anywhere; }
@media print {
  .st-labels { grid-template-columns: repeat(3, 1fr); gap: 2mm; }
  .st-labels__label { border-color: #999; }
}
</style>
