// Shared recording logic of the input fields. A value that already exists is never edited in place:
// a change is a new input.recorded that supersedes the current one, plus a note carrying the reason.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Input, InputProjection, InputValue, RunEvent, Uuid } from '../../../domain/types'
import { useRunsStore, type Signer } from '../../../stores'
import { errorLines } from '../errors'

export interface FieldProps<I extends Input = Input> {
  runId: Uuid
  stepId: Uuid
  input: I
  /** projection of this input (value + current event id), undefined before anything is recorded */
  state?: InputProjection
  /** false while the step is read-only (lock, checkout, closed run, completed or conflicted step) */
  editable: boolean
}

export interface RecordOptions {
  ocrRaw?: string
  signer?: Signer
  /** additions that lose nothing (another photo) need no reason */
  additive?: boolean
}

export function useField(props: FieldProps) {
  const { t } = useI18n()
  const runs = useRunsStore()

  const busy = ref(false)
  const errors = ref<string[]>([])
  const correcting = ref(false)
  const reason = ref('')

  const currentEvent = computed<RunEvent<'input.recorded'> | null>(() => {
    const id = props.state?.event_id
    if (!id) return null
    return (runs.events(props.runId).find((e) => e.id === id) as RunEvent<'input.recorded'> | undefined) ?? null
  })

  /** earlier values of this input (superseded or rejected), oldest first — shown for traceability */
  const history = computed<RunEvent<'input.recorded'>[]>(() =>
    runs.events(props.runId).filter(
      (e): e is RunEvent<'input.recorded'> =>
        e.type === 'input.recorded' && e.step_id === props.stepId &&
        (e as RunEvent<'input.recorded'>).payload.input_id === props.input.id && e.id !== props.state?.event_id,
    ),
  )

  const hasValue = computed(() => props.state?.value != null)
  /** the editor is shown when nothing is recorded yet, or while a correction is being entered */
  const showEditor = computed(() => props.editable && (!hasValue.value || correcting.value))

  function startCorrection() {
    correcting.value = true
    reason.value = ''
    errors.value = []
  }

  function cancelCorrection() {
    correcting.value = false
    reason.value = ''
    errors.value = []
  }

  async function record(value: InputValue, source: 'manual' | 'ocr' | 'scan', opts: RecordOptions = {}): Promise<boolean> {
    errors.value = []
    const previous = currentEvent.value
    const isCorrection = !!previous && !opts.additive
    if (isCorrection && !reason.value.trim()) {
      errors.value = [t('st.run.correction.reasonRequired')]
      return false
    }
    busy.value = true
    try {
      await runs.recordInput({
        runId: props.runId, stepId: props.stepId, inputId: props.input.id, value, source,
        ocrRaw: opts.ocrRaw, supersedes: previous?.id ?? null, signer: opts.signer,
      })
    } catch (e) {
      errors.value = errorLines(e, t)
      busy.value = false
      return false
    }
    try {
      if (isCorrection) {
        // fixed English prefix like other system-written notes; the reason itself is the operator's words
        await runs.addNote(props.runId, props.stepId, `Correction of "${props.input.label}" (supersedes ${previous!.id}): ${reason.value.trim()}`, opts.signer)
      }
      correcting.value = false
      reason.value = ''
      return true
    } catch (e) {
      // the value is recorded; only the explanation is missing — say so, the operator can add it as a note
      correcting.value = false
      errors.value = [t('st.run.correction.noteFailed'), ...errorLines(e, t)]
      return true
    } finally {
      busy.value = false
    }
  }

  return { busy, errors, correcting, reason, currentEvent, history, hasValue, showEditor, startCorrection, cancelCorrection, record }
}
