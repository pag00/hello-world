<script setup lang="ts">
// Opens the scanner (web: full-screen camera overlay; native: system scanner UI) and emits the scanned
// text once. `expect` (exact or /regex/) is only a hint for UI feedback: a mismatch is shown and the
// operator may rescan or pass the text on — the consuming field enforces `expect` itself.
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDevice } from '../../device'
import { checkExpect, describeExpect } from '../../device/expect'
import { errorMessage } from '../../device/errors'
import StDialog from '../StDialog.vue'
import ScannerOverlay from './ScannerOverlay.vue'

// several root nodes (button + teleported overlay/dialog): attrs belong on the button
defineOptions({ name: 'ScanButton', inheritAttrs: false })

const props = withDefaults(defineProps<{ label?: string; expect?: string | null; disabled?: boolean; size?: 'md' | 'lg' }>(), {
  label: undefined,
  expect: null,
  size: 'md',
})
const emit = defineEmits<{ scanned: [text: string]; error: [message: string] }>()

const { t } = useI18n()
const device = useDevice()
const overlayOpen = ref(false)
const busy = ref(false)
/** native path: scanned text that does not match `expect`, awaiting the operator's choice */
const mismatch = ref<string | null>(null)
let ctrl: AbortController | null = null

function expectHint(): string | null {
  const h = describeExpect(props.expect)
  if (h.kind === 'exact') return t('st.device.scan.expectExact', { value: h.value })
  if (h.kind === 'pattern') return t('st.device.scan.expectPattern', { pattern: h.pattern })
  return null
}

async function start() {
  if (props.disabled || busy.value || overlayOpen.value) return
  const scanner = device.scanner
  busy.value = true
  try {
    if (!(await scanner.isSupported())) {
      emit('error', 'st.device.errors.scannerUnsupported')
      return
    }
    if (scanner.kind === 'web') {
      overlayOpen.value = true
      return
    }
    ctrl = new AbortController()
    const r = await scanner.scanOnce({ signal: ctrl.signal })
    if (!r) return
    if (checkExpect(r.text, props.expect) === 'mismatch') mismatch.value = r.text
    else emit('scanned', r.text)
  } catch (e) {
    emit('error', errorMessage(e, 'scanFailed'))
  } finally {
    busy.value = false
    ctrl = null
  }
}

function onResult(text: string) {
  overlayOpen.value = false
  emit('scanned', text)
}

function onOverlayError(m: string) {
  overlayOpen.value = false
  emit('error', m)
}

function rescan() {
  mismatch.value = null
  void start()
}

function useAnyway() {
  const text = mismatch.value
  mismatch.value = null
  if (text !== null) emit('scanned', text)
}

onBeforeUnmount(() => ctrl?.abort())
</script>

<template>
  <button
    v-bind="$attrs"
    class="st-btn st-scanbtn"
    :class="{ 'st-btn--lg': size === 'lg', 'st-btn--primary': size === 'lg' }"
    type="button"
    :disabled="disabled || busy"
    :aria-busy="busy"
    data-test="scan-button"
    @click="start"
  >
    <svg class="st-scanbtn__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M3 3h6v2H5v4H3V3zm12 0h6v6h-2V5h-4V3zM3 15h2v4h4v2H3v-6zm16 0h2v6h-6v-2h4v-4zM7 7h4v4H7V7zm6 0h4v4h-4V7zm-6 6h4v4H7v-4zm8 0h2v2h-2v-2zm-2 2h2v2h-2v-2zm2 0h2v2h-2v-2z"
        fill="currentColor"
      />
    </svg>
    <span>{{ label ?? t('st.device.scan.button') }}</span>
  </button>

  <ScannerOverlay :open="overlayOpen" :expect="expect" :title="label" @result="onResult" @cancel="overlayOpen = false" @error="onOverlayError" />

  <StDialog :open="mismatch !== null" :title="t('st.device.scan.mismatchTitle')" @close="mismatch = null">
    <p>{{ t('st.device.scan.mismatch') }}</p>
    <code class="st-scanbtn__value st-mono" data-test="scan-mismatch-value">{{ mismatch }}</code>
    <p v-if="expectHint()" class="st-hint">{{ expectHint() }}</p>
    <template #actions>
      <button type="button" class="st-btn" data-test="scan-use-anyway" @click="useAnyway">{{ t('st.device.scan.useAnyway') }}</button>
      <button type="button" class="st-btn st-btn--primary" data-test="scan-again" @click="rescan">{{ t('st.device.scan.rescan') }}</button>
    </template>
  </StDialog>
</template>

<style scoped>
.st-scanbtn__icon { width: 1.4em; height: 1.4em; flex: none; }
.st-scanbtn__value { display: block; font-size: 1.3rem; word-break: break-all; }
</style>
