<script setup lang="ts">
// Scanned identifier (part or tool). `expect` is enforced before anything is recorded. Tools are checked
// against the calibration register: online an expired/unknown/withdrawn tool is refused; offline the
// register may be stale, so the scan is recorded with a warning and an NCR is required (§3.2).
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ScanInput, Uuid } from '../../../domain/types'
import { matchesExpect } from '../../../domain/validation'
import { useRegistryStore, useSessionStore } from '../../../stores'
import ScanButton from '../../device/ScanButton.vue'
import { deviceErrorText } from '../errors'
import CorrectionReason from './CorrectionReason.vue'
import FieldFrame from './FieldFrame.vue'
import RecordedMeta from './RecordedMeta.vue'
import { useField, type FieldProps } from './useField'

type ToolStatus = 'ok' | 'expired' | 'unknown' | 'inactive'

const props = defineProps<FieldProps<ScanInput>>()
const emit = defineEmits<{ raiseNcr: [req: { inputId: Uuid; prefill: string }] }>()
const { t } = useI18n()
const registry = useRegistryStore()
const session = useSessionStore()
const f = useField(props)
const { busy, errors, currentEvent, history, hasValue, showEditor, correcting, reason } = f

const typing = ref(false)
const typed = ref('')
/** offline scan of a problematic tool waiting for the operator to confirm recording it anyway */
const pending = ref<{ value: string; source: 'scan' | 'manual'; status: ToolStatus } | null>(null)

const expectIsRegex = computed(() => !!props.input.expect && /^\/.*\/[a-z]*$/s.test(props.input.expect))
const expectText = computed(() => {
  const e = props.input.expect
  if (!e) return null
  return expectIsRegex.value ? t('st.run.scan.expectPattern', { pattern: e }) : t('st.run.scan.expectExact', { value: e })
})

const recorded = computed(() => (typeof props.state?.value === 'string' ? props.state.value : null))
// calibration matters at the time of use, not today
const recordedTool = computed(() => {
  if (props.input.entity !== 'tool' || !recorded.value) return null
  const at = currentEvent.value ? new Date(currentEvent.value.client_ts) : undefined
  return registry.checkTool(recorded.value, at)
})
const serverToolFlag = computed(() => {
  const fl = currentEvent.value?.flags ?? []
  return fl.includes('tool_expired') ? 'expired' : fl.includes('tool_unknown') ? 'unknown' : null
})
/** current tool problem: what the server flagged, else what the local register says now */
const toolProblem = computed<ToolStatus | null>(() => {
  if (serverToolFlag.value) return serverToolFlag.value
  const s = recordedTool.value?.status
  return s && s !== 'ok' ? s : null
})
const covered = computed(() =>
  registry.ncrs.some((n) => n.run_id === props.runId && n.step_id === props.stepId && (n.input_id == null || n.input_id === props.input.id)),
)

function onDeviceError(m: string) {
  errors.value = [deviceErrorText(m, t)]
}

async function accept(raw: string, source: 'scan' | 'manual') {
  errors.value = []
  pending.value = null
  const value = raw.trim()
  if (!value) {
    errors.value = [t('st.run.scan.empty')]
    return
  }
  if (!matchesExpect(value, props.input.expect)) {
    errors.value = [t('st.run.scan.mismatch', { value }), expectText.value ?? ''].filter(Boolean)
    return
  }
  if (props.input.entity === 'tool') {
    const status = registry.checkTool(value).status
    if (status !== 'ok') {
      if (session.online) {
        errors.value = [t(`st.run.scan.toolBlocked.${status}`, { code: value })]
        return
      }
      pending.value = { value, source, status }
      return
    }
  }
  await commit(value, source)
}

async function commit(value: string, source: 'scan' | 'manual') {
  if (await f.record(value, source)) {
    typed.value = ''
    typing.value = false
    pending.value = null
  }
}

function begin() {
  typed.value = ''
  typing.value = false
  pending.value = null
  f.startCorrection()
}

function raiseNcr() {
  emit('raiseNcr', {
    inputId: props.input.id,
    prefill: t('st.run.scan.ncrPrefill', { label: props.input.label, code: recorded.value ?? '', status: t(`st.run.tool.${toolProblem.value ?? 'unknown'}`) }),
  })
}
</script>

<template>
  <FieldFrame :input="input" :errors="errors" :tone="hasValue ? (toolProblem ? (covered ? 'warn' : 'danger') : 'ok') : null">
    <p v-if="expectText" class="st-hint" data-test="expect-hint">{{ expectText }}</p>

    <template v-if="hasValue && !correcting">
      <p class="st-scan__value st-mono" data-test="scan-value">{{ recorded }}</p>
      <p v-if="recordedTool?.tool" class="st-muted">
        {{ recordedTool.tool.description }}
        <template v-if="recordedTool.tool.calibration_due"> · {{ t('st.run.tool.due', { date: recordedTool.tool.calibration_due }) }}</template>
      </p>
      <div v-if="toolProblem" class="st-alert st-alert--danger st-stack" data-test="tool-problem">
        <strong>{{ t(`st.run.tool.${toolProblem}`) }}</strong>
        <span v-if="covered">{{ t('st.run.scan.ncrCovered') }}</span>
        <template v-else>
          <span>{{ t('st.run.scan.ncrNeeded') }}</span>
          <div><button type="button" class="st-btn st-btn--danger" data-test="raise-ncr" @click="raiseNcr">{{ t('st.run.ncr.raise') }}</button></div>
        </template>
      </div>
    </template>
    <RecordedMeta :event="currentEvent" :history="history" />
    <div v-if="editable && hasValue && !correcting">
      <button type="button" class="st-btn" data-test="correct" @click="begin">{{ t('st.run.correction.start') }}</button>
    </div>

    <template v-if="showEditor">
      <div v-if="pending" class="st-alert st-alert--warn st-stack" role="alert" data-test="offline-tool-warning">
        <strong>{{ t(`st.run.scan.toolBlocked.${pending.status}`, { code: pending.value }) }}</strong>
        <span>{{ t('st.run.scan.offlineToolWarning') }}</span>
        <div class="st-row">
          <button type="button" class="st-btn" @click="pending = null">{{ t('st.common.cancel') }}</button>
          <button type="button" class="st-btn st-btn--danger" :disabled="busy" data-test="record-anyway" @click="commit(pending.value, pending.source)">
            {{ t('st.run.scan.recordAnyway') }}
          </button>
        </div>
      </div>
      <div v-else class="st-row">
        <ScanButton
          :label="input.entity === 'tool' ? t('st.run.scan.scanTool') : t('st.run.scan.scanPart')"
          :expect="input.expect"
          :disabled="busy"
          size="lg"
          @scanned="(text: string) => accept(text, 'scan')"
          @error="onDeviceError"
        />
        <button type="button" class="st-btn st-btn--ghost" :aria-expanded="typing" data-test="type-instead" @click="typing = !typing">
          {{ t('st.run.scan.typeInstead') }}
        </button>
      </div>
      <div v-if="typing && !pending" class="st-row">
        <input v-model="typed" class="st-input st-mono st-scan__typed" type="text" autocomplete="off" :aria-label="input.label" data-test="scan-typed" @keydown.enter="accept(typed, 'manual')" />
        <button type="button" class="st-btn st-btn--primary" :disabled="busy || !typed.trim()" data-test="record" @click="accept(typed, 'manual')">
          {{ t('st.run.record') }}
        </button>
      </div>
      <CorrectionReason v-if="correcting" v-model="reason" @cancel="f.cancelCorrection()" />
    </template>
    <p v-else-if="!hasValue" class="st-muted">{{ t('st.run.value.none') }}</p>
  </FieldFrame>
</template>

<style scoped>
.st-scan__value { margin: 0; font-size: 1.6rem; font-weight: 700; word-break: break-all; }
.st-scan__typed { flex: 1; min-width: 14ch; }
</style>
