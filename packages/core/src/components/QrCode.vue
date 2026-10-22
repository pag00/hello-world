<script setup lang="ts">
// QR code as inline SVG (error correction M). Built from the module matrix rather than a generated
// SVG string, so nothing is injected via v-html and it renders synchronously (print-ready immediately).
import { computed } from 'vue'
import QRCode from 'qrcode'

const props = withDefaults(defineProps<{ value: string; size?: number | string; margin?: number; label?: string }>(), {
  size: 160,
  margin: 4,
})

const matrix = computed(() => {
  try {
    const m = QRCode.create(props.value, { errorCorrectionLevel: 'M' }).modules
    return { size: m.size, data: m.data }
  } catch {
    return null
  }
})

// one path, one rect per dark run in each row: compact even for long URLs
const path = computed(() => {
  const m = matrix.value
  if (!m) return ''
  let d = ''
  for (let y = 0; y < m.size; y++) {
    let x = 0
    while (x < m.size) {
      if (!m.data[y * m.size + x]) {
        x++
        continue
      }
      const start = x
      while (x < m.size && m.data[y * m.size + x]) x++
      d += `M${start + props.margin} ${y + props.margin}h${x - start}v1h${start - x}z`
    }
  }
  return d
})

const box = computed(() => (matrix.value ? matrix.value.size + props.margin * 2 : 1))
const cssSize = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size))
</script>

<template>
  <svg
    class="st-qr"
    xmlns="http://www.w3.org/2000/svg"
    :viewBox="`0 0 ${box} ${box}`"
    :width="cssSize"
    :height="cssSize"
    shape-rendering="crispEdges"
    role="img"
    :aria-label="label ?? value"
    :data-value="value"
  >
    <rect width="100%" height="100%" fill="#fff" />
    <path v-if="path" :d="path" fill="#000" />
  </svg>
</template>

<style scoped>
/* always black on white, also in dark mode: scanners need the contrast */
.st-qr { display: block; background: #fff; }
</style>
