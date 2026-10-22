<script setup lang="ts">
// Full-screen camera view for the web scanner. Teleports to <body> and re-applies .st-root (like StDialog)
// so tokens work when embedded. A code that does not match `expect` is shown, not silently dropped: the
// operator can rescan without leaving the camera, or pass it on (the step still enforces `expect`).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDevice } from '../../device'
import { checkExpect, describeExpect } from '../../device/expect'
import { errorMessage } from '../../device/errors'

const props = defineProps<{ open: boolean; expect?: string | null; title?: string }>()
const emit = defineEmits<{ result: [text: string]; cancel: []; error: [message: string] }>()

const { t } = useI18n()
const device = useDevice()
const video = ref<HTMLVideoElement | null>(null)
const phase = ref<'starting' | 'scanning' | 'mismatch'>('starting')
const scanned = ref('')
const torchSupported = ref(false)
const torchOn = ref(false)
let ctrl: AbortController | null = null
let generation = 0

const hint = computed(() => {
  const h = describeExpect(props.expect)
  if (h.kind === 'exact') return t('st.device.scan.expectExact', { value: h.value })
  if (h.kind === 'pattern') return t('st.device.scan.expectPattern', { pattern: h.pattern })
  return null
})

function videoTrack(): MediaStreamTrack | null {
  const src = video.value?.srcObject
  return src && typeof (src as MediaStream).getVideoTracks === 'function' ? ((src as MediaStream).getVideoTracks()[0] ?? null) : null
}

function onPlaying() {
  phase.value = phase.value === 'starting' ? 'scanning' : phase.value
  const track = videoTrack()
  const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean }
  torchSupported.value = !!caps.torch
}

async function toggleTorch() {
  const track = videoTrack()
  if (!track) return
  const next = !torchOn.value
  try {
    await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
    torchOn.value = next
  } catch {
    torchSupported.value = false
  }
}

function stop() {
  generation++
  ctrl?.abort()
  ctrl = null
  torchOn.value = false
  torchSupported.value = false
}

async function start() {
  stop()
  const mine = generation
  phase.value = 'starting'
  scanned.value = ''
  await nextTick()
  if (mine !== generation || !props.open || !video.value) return
  ctrl = new AbortController()
  try {
    const r = await device.scanner.scanOnce({ video: video.value, signal: ctrl.signal })
    if (mine !== generation) return
    if (!r) return
    if (checkExpect(r.text, props.expect) === 'mismatch') {
      scanned.value = r.text
      phase.value = 'mismatch'
      torchOn.value = false
      return
    }
    emit('result', r.text)
  } catch (e) {
    if (mine === generation) emit('error', errorMessage(e, 'scanFailed'))
  }
}

function cancel() {
  stop()
  emit('cancel')
}

function useAnyway() {
  const text = scanned.value
  stop()
  emit('result', text)
}

watch(
  () => props.open,
  (open) => (open ? void start() : stop()),
  { immediate: true },
)

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) cancel()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  stop()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="st-root">
      <div class="st-scanner" role="dialog" aria-modal="true" :aria-label="title ?? t('st.device.scan.title')" data-test="scanner-overlay">
        <video ref="video" class="st-scanner__video" muted playsinline autoplay @playing="onPlaying" />
        <div class="st-scanner__frame" :class="{ 'st-scanner__frame--warn': phase === 'mismatch' }" aria-hidden="true" />

        <header class="st-scanner__top">
          <h2 class="st-scanner__title">{{ title ?? t('st.device.scan.title') }}</h2>
          <p class="st-scanner__hint" aria-live="polite">
            {{ phase === 'starting' ? t('st.device.scan.starting') : t('st.device.scan.hint') }}
          </p>
          <p v-if="hint" class="st-scanner__expect st-mono">{{ hint }}</p>
        </header>

        <div v-if="phase === 'mismatch'" class="st-scanner__mismatch st-card st-stack" role="alert" data-test="scan-mismatch">
          <strong>{{ t('st.device.scan.mismatchTitle') }}</strong>
          <span>{{ t('st.device.scan.mismatch') }}</span>
          <code class="st-scanner__value st-mono">{{ scanned }}</code>
          <span v-if="hint" class="st-hint">{{ hint }}</span>
          <div class="st-row">
            <button type="button" class="st-btn st-btn--primary st-btn--lg" data-test="scan-again" @click="start">{{ t('st.device.scan.rescan') }}</button>
            <button type="button" class="st-btn st-btn--lg" data-test="scan-use-anyway" @click="useAnyway">{{ t('st.device.scan.useAnyway') }}</button>
          </div>
        </div>

        <footer class="st-scanner__bottom">
          <button
            v-if="torchSupported && phase !== 'mismatch'"
            type="button"
            class="st-btn st-btn--lg st-scanner__torch"
            :aria-pressed="torchOn"
            data-test="scan-torch"
            @click="toggleTorch"
          >
            {{ torchOn ? t('st.device.scan.torchOff') : t('st.device.scan.torchOn') }}
          </button>
          <span class="st-spacer" />
          <button type="button" class="st-btn st-btn--lg st-scanner__cancel" data-test="scan-cancel" @click="cancel">{{ t('st.common.cancel') }}</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.st-scanner {
  position: fixed; inset: 0; z-index: 1100; background: #000; color: #fff;
  display: flex; flex-direction: column; overflow: hidden;
}
.st-scanner__video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.st-scanner__frame {
  position: absolute; left: 50%; top: 50%; width: min(70vmin, 520px); aspect-ratio: 1; transform: translate(-50%, -50%);
  border: 4px solid rgb(255 255 255 / 0.9); border-radius: 18px;
  box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.45);
}
.st-scanner__frame--warn { border-color: var(--st-warn); }
.st-scanner__top, .st-scanner__bottom {
  position: relative; display: flex; gap: var(--st-gap); padding: 16px 20px;
  background: linear-gradient(rgb(0 0 0 / 0.65), rgb(0 0 0 / 0));
}
.st-scanner__top { flex-direction: column; gap: 4px; }
.st-scanner__bottom {
  margin-top: auto; align-items: center;
  background: linear-gradient(rgb(0 0 0 / 0), rgb(0 0 0 / 0.65));
  padding-bottom: max(16px, env(safe-area-inset-bottom));
}
.st-scanner__title { margin: 0; font-size: 1.3rem; }
.st-scanner__hint { margin: 0; font-size: 1.05rem; }
.st-scanner__expect { margin: 0; font-size: 1rem; opacity: 0.9; }
.st-scanner__mismatch {
  position: relative; margin: auto 16px 0; align-self: center; width: min(560px, calc(100% - 32px));
  color: var(--st-text); border-color: var(--st-warn);
}
.st-scanner__value { font-size: 1.4rem; word-break: break-all; }
.st-scanner__cancel, .st-scanner__torch { min-width: 140px; }
</style>
