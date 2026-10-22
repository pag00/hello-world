<script setup lang="ts">
// Executing one step: lease, instructions, inputs, completion, verification, reopen, notes, conflicts.
import { computed, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { deadEventIds } from '../domain/projection'
import type { RunEvent, Uuid } from '../domain/types'
import { useRegistryStore, useRunsStore, useSessionStore, type Signer } from '../stores'
import BlobImage from '../components/session/BlobImage.vue'
import PinDialog from '../components/session/PinDialog.vue'
import CompleteStepPanel from '../components/run/CompleteStepPanel.vue'
import ConflictPanel from '../components/run/ConflictPanel.vue'
import NcrRaiseDialog from '../components/run/NcrRaiseDialog.vue'
import ReasonDialog from '../components/run/ReasonDialog.vue'
import RunHeader from '../components/run/RunHeader.vue'
import RunNcrList from '../components/run/RunNcrList.vue'
import StepStateBadge from '../components/run/StepStateBadge.vue'
import InputField from '../components/run/inputs/InputField.vue'
import { errorLines } from '../components/run/errors'
import { fmtDateTime } from '../components/run/format'
import { renderMarkdown } from '../components/run/markdown'
import { pendingDependencies } from '../components/run/runNav'
import { useRunContext } from '../components/run/useRunContext'
import { useStepLock } from '../components/run/useStepLock'

const props = defineProps<{ runId: string; stepId: string }>()
const { t, locale } = useI18n()
const runs = useRunsStore()
const registry = useRegistryStore()
const session = useSessionStore()

const runIdRef = toRef(props, 'runId')
const stepIdRef = toRef(props, 'stepId')
const { loaded, run, revision, procedure, content, projection, steps, status, closed, progress, checkout, now } = useRunContext(runIdRef)

watch(
  [run, closed],
  ([r, c]) => {
    if (r && !c) runs.activeRunId = r.id
  },
  { immediate: true },
)

const index = computed(() => steps.value.findIndex((s) => s.step.id === props.stepId))
const current = computed(() => steps.value[index.value] ?? null)
const step = computed(() => current.value?.step ?? null)
const prev = computed(() => (index.value > 0 ? steps.value[index.value - 1] : null))
const next = computed(() => (index.value >= 0 && index.value < steps.value.length - 1 ? steps.value[index.value + 1] : null))
const sp = computed(() => projection.value?.steps[props.stepId])
const state = computed(() => sp.value?.state ?? 'pending')
const done = computed(() => state.value === 'completed' || state.value === 'verified')

// ---- lease
const lock = useStepLock({
  runId: runIdRef,
  stepId: stepIdRef,
  ready: loaded,
  closed,
  checkedOut: computed(() => !!checkout.value),
  now,
})

const editCheck = computed(() => {
  void now.value
  return runs.canEdit(props.runId, props.stepId)
})
const editable = computed(() => editCheck.value.ok && !done.value && state.value !== 'conflict')
const isSupervisor = computed(() => session.hasRole('supervisor'))

const readOnlyText = computed(() => {
  const c = editCheck.value
  if (c.ok) return null
  if (c.reason === 'not_locked') {
    if (lock.state.value === 'acquiring' || lock.state.value === 'idle') return t('st.run.lock.acquiring')
    if (lock.state.value === 'error') return t('st.run.lock.failed')
    // 409 without holder details (e.g. the run is checked out to another tablet)
    if (lock.state.value === 'refused') return t('st.run.lock.refused')
  }
  if (c.reason === 'locked_by_other' && lock.foreign.value) {
    return t('st.run.lock.refusedBy', {
      name: registry.userName(lock.foreign.value.holder_user),
      until: fmtDateTime(lock.foreign.value.expires_at, locale.value),
    })
  }
  return t(`st.run.readOnly.${c.reason}`)
})
const lockRefused = computed(() => !editCheck.value.ok && (editCheck.value.reason === 'locked_by_other' || lock.state.value === 'refused'))

const takeoverOpen = ref(false)
const takeoverErrors = ref<string[]>([])
async function takeOver() {
  takeoverErrors.value = []
  await lock.acquire(true)
  if (lock.state.value === 'held') takeoverOpen.value = false
  else takeoverErrors.value = errorLines(lock.error.value, t)
}

// ---- instructions
const html = computed(() => renderMarkdown(step.value?.instructions))
const waitingFor = computed(() => (step.value ? pendingDependencies(step.value, projection.value, steps.value) : []))

// ---- NCR
const ncr = ref<{ open: boolean; inputId: Uuid | null; prefill: string; context: string }>({ open: false, inputId: null, prefill: '', context: '' })
function raiseForInput(r: { inputId: Uuid; prefill: string }) {
  const input = step.value?.inputs.find((i) => i.id === r.inputId)
  ncr.value = { open: true, inputId: r.inputId, prefill: r.prefill, context: t('st.run.ncr.inputContext', { label: input?.label ?? '' }) }
}
function raiseForStep() {
  ncr.value = { open: true, inputId: null, prefill: '', context: t('st.run.ncr.stepContext', { step: `${current.value?.number} ${step.value?.title}` }) }
}

// ---- verification
const verifyOpen = ref(false)
const verifyErrors = ref<string[]>([])
const needsVerify = computed(() => !!step.value?.verification?.required && state.value === 'completed')
async function onVerify(signer: Signer) {
  verifyOpen.value = false
  verifyErrors.value = []
  try {
    await runs.verifyStep(props.runId, props.stepId, signer)
  } catch (e) {
    verifyErrors.value = errorLines(e, t)
  }
}

// ---- reopen: reason first, then the supervisor confirms identity
const reopenReasonOpen = ref(false)
const reopenPinOpen = ref(false)
const reopenReason = ref('')
const reopenErrors = ref<string[]>([])
const canReopen = computed(() => !closed.value && (done.value || state.value === 'conflict'))
function onReopenReason(reason: string) {
  reopenReason.value = reason
  reopenReasonOpen.value = false
  reopenPinOpen.value = true
}
async function onReopenSigned(signer: Signer) {
  reopenPinOpen.value = false
  reopenErrors.value = []
  try {
    await runs.reopenStep(props.runId, props.stepId, reopenReason.value, signer)
    reopenReason.value = ''
  } catch (e) {
    reopenErrors.value = errorLines(e, t)
  }
}

// ---- notes
const notes = computed(() => {
  const all = runs.events(props.runId)
  const dead = deadEventIds(all)
  return all.filter((e): e is RunEvent<'note.added'> => e.type === 'note.added' && e.step_id === props.stepId && !dead.has(e.id))
})
const noteText = ref('')
const noteBusy = ref(false)
const noteErrors = ref<string[]>([])
async function addNote() {
  if (!noteText.value.trim()) return
  noteBusy.value = true
  noteErrors.value = []
  try {
    await runs.addNote(props.runId, props.stepId, noteText.value)
    noteText.value = ''
  } catch (e) {
    noteErrors.value = errorLines(e, t)
  } finally {
    noteBusy.value = false
  }
}
</script>

<template>
  <div class="st-page st-stack st-stepview">
    <p v-if="!loaded" class="st-muted">{{ t('st.common.loading') }}</p>
    <div v-else-if="!run || !step" class="st-card st-stack" data-test="step-missing">
      <p class="st-alert st-alert--warn">{{ run ? t('st.run.stepNotInRevision') : t('st.run.notOnDevice') }}</p>
      <RouterLink v-if="run" class="st-btn" :to="{ name: 'st-run', params: { runId } }">{{ t('st.run.backToRun') }}</RouterLink>
      <RouterLink v-else class="st-btn" :to="{ name: 'st-runs' }">{{ t('st.run.qr.allRuns') }}</RouterLink>
    </div>

    <template v-else>
      <section class="st-card st-stack">
        <div class="st-row st-noprint">
          <RouterLink class="st-btn st-btn--ghost" :to="{ name: 'st-run', params: { runId } }" data-test="back-to-run">← {{ t('st.run.backToRun') }}</RouterLink>
        </div>
        <RunHeader :run="run" :procedure="procedure" :revision="revision" :status="status" :progress="progress" compact />
      </section>

      <section class="st-stack">
        <div class="st-row st-stepview__titlebar">
          <span class="st-mono st-stepview__num">{{ current!.number }}</span>
          <h1 class="st-h1 st-stepview__title">{{ step.title }}</h1>
          <StepStateBadge :state="state" />
        </div>
        <p class="st-hint">{{ current!.section.title }}<template v-if="step.locations.length"> · {{ t('st.run.locations', { codes: step.locations.join(', ') }) }}</template></p>
      </section>

      <!-- read-only explanation and lease -->
      <div v-if="readOnlyText" class="st-alert st-alert--warn st-stack" role="status" data-test="readonly-banner">
        <span>{{ readOnlyText }}</span>
        <div v-if="lockRefused && session.online" class="st-row">
          <button type="button" class="st-btn" data-test="lock-retry" @click="lock.acquire()">{{ t('st.run.lock.retry') }}</button>
          <button v-if="isSupervisor" type="button" class="st-btn st-btn--danger" data-test="lock-takeover" @click="takeoverOpen = true">
            {{ t('st.run.lock.takeOver') }}
          </button>
        </div>
        <div v-else-if="editCheck.ok === false && editCheck.reason === 'not_locked' && lock.state.value === 'error'">
          <button type="button" class="st-btn" @click="lock.acquire()">{{ t('st.run.lock.retry') }}</button>
        </div>
      </div>
      <p v-else-if="done" class="st-alert st-alert--info" data-test="done-banner">{{ t('st.run.stepDoneReadOnly') }}</p>

      <p v-if="waitingFor.length && !done" class="st-alert st-alert--info">
        {{ t('st.run.dependsOn', { steps: waitingFor.map((w) => `${w.number} ${w.step.title}`).join(', ') }) }}
      </p>

      <ConflictPanel v-if="state === 'conflict'" :run-id="runId" :step="step" />

      <section v-if="html || step.media.length" class="st-card st-stack">
        <h2 class="st-h2">{{ t('st.run.instructions') }}</h2>
        <!-- eslint-disable-next-line vue/no-v-html -- sanitized by renderMarkdown (DOMPurify) -->
        <div v-if="html" class="st-md" data-test="instructions" v-html="html" />
        <div v-if="step.media.length" class="st-stepview__media">
          <BlobImage v-for="m in step.media" :key="m" :ref-id="m" :alt="t('st.run.referenceImage')" />
        </div>
      </section>

      <section v-if="step.inputs.length" class="st-stack" data-test="inputs">
        <InputField
          v-for="input in step.inputs"
          :key="input.id"
          :run-id="runId"
          :step-id="stepId"
          :input="input"
          :state="sp?.inputs[input.id]"
          :editable="editable"
          @raise-ncr="raiseForInput"
        />
      </section>
      <p v-else class="st-muted">{{ t('st.run.noInputs') }}</p>

      <CompleteStepPanel v-if="!done && state !== 'conflict' && !closed" :run-id="runId" :step="step" :editable="editCheck.ok" />

      <section v-if="done || needsVerify" class="st-card st-stack" data-test="completion-info">
        <p v-if="sp?.completed_by">{{ t('st.run.completedBy', { name: registry.userName(sp.completed_by), time: fmtDateTime(sp.completed_at, locale) }) }}</p>
        <p v-if="sp?.verified_by" class="st-alert st-alert--ok">
          {{ t('st.run.verifiedBy', { name: registry.userName(sp.verified_by), time: fmtDateTime(sp.verified_at, locale) }) }}
        </p>
        <template v-if="needsVerify && !closed">
          <p class="st-alert st-alert--info">{{ t('st.run.awaitsVerification', { role: t(`st.session.roles.${step.verification!.role}`) }) }}</p>
          <p class="st-hint">{{ t('st.run.verify.notCompleter') }}</p>
          <div>
            <button type="button" class="st-btn st-btn--primary st-btn--lg" :disabled="!editCheck.ok" data-test="verify" @click="verifyOpen = true">
              {{ t('st.run.verify.button') }}
            </button>
          </div>
          <p v-for="e in verifyErrors" :key="e" class="st-alert st-alert--danger" role="alert">{{ e }}</p>
        </template>
      </section>

      <section class="st-card st-stack" data-test="notes">
        <h2 class="st-h2">{{ t('st.run.notes.title') }}</h2>
        <p v-if="!notes.length" class="st-muted">{{ t('st.run.notes.none') }}</p>
        <ul v-else class="st-notes">
          <li v-for="n in notes" :key="n.id" class="st-notes__item">
            <span class="st-notes__text">{{ n.payload.text }}</span>
            <span class="st-hint">
              {{ t('st.run.meta.by', { name: registry.userName(n.actor_id), time: fmtDateTime(n.client_ts, locale) }) }}
              <span v-if="n.payload.system" class="st-badge">{{ t('st.run.notes.system') }}</span>
            </span>
          </li>
        </ul>
        <template v-if="editCheck.ok && !closed">
          <textarea v-model="noteText" class="st-textarea" rows="2" :aria-label="t('st.run.notes.add')" data-test="note-text" />
          <div>
            <button type="button" class="st-btn" :disabled="noteBusy || !noteText.trim()" data-test="note-add" @click="addNote">{{ t('st.run.notes.add') }}</button>
          </div>
          <p v-for="e in noteErrors" :key="e" class="st-alert st-alert--danger" role="alert">{{ e }}</p>
        </template>
      </section>

      <RunNcrList :run-id="runId" :content="content" :step-id="stepId" :can-raise="editCheck.ok && !closed" @raise="raiseForStep" />

      <section v-if="canReopen" class="st-card st-stack">
        <h2 class="st-h2">{{ t('st.run.reopen.title') }}</h2>
        <p class="st-hint">{{ t('st.run.reopen.explain') }}</p>
        <div>
          <button type="button" class="st-btn" :disabled="!editCheck.ok" data-test="reopen" @click="reopenReasonOpen = true">{{ t('st.run.reopen.button') }}</button>
        </div>
        <p v-for="e in reopenErrors" :key="e" class="st-alert st-alert--danger" role="alert">{{ e }}</p>
      </section>

      <nav class="st-row st-stepview__nav st-noprint">
        <RouterLink v-if="prev" class="st-btn st-btn--lg" :to="{ name: 'st-run-step', params: { runId, stepId: prev.step.id } }" data-test="prev-step">
          ← {{ prev.number }} {{ prev.step.title }}
        </RouterLink>
        <span class="st-spacer" />
        <RouterLink v-if="next" class="st-btn st-btn--lg" :to="{ name: 'st-run-step', params: { runId, stepId: next.step.id } }" data-test="next-step">
          {{ next.number }} {{ next.step.title }} →
        </RouterLink>
        <RouterLink v-else class="st-btn st-btn--lg" :to="{ name: 'st-run', params: { runId } }">{{ t('st.run.backToRun') }}</RouterLink>
      </nav>

      <NcrRaiseDialog
        :open="ncr.open"
        :run-id="runId"
        :step-id="stepId"
        :input-id="ncr.inputId"
        :prefill="ncr.prefill"
        :context="ncr.context"
        @close="ncr.open = false"
      />
      <PinDialog
        :open="verifyOpen"
        :title="t('st.run.verify.dialogTitle')"
        :role="step.verification?.role ?? 'inspector'"
        :exclude-user-ids="sp?.completed_by ? [sp.completed_by] : []"
        @signed="onVerify"
        @close="verifyOpen = false"
      />
      <ReasonDialog
        :open="reopenReasonOpen"
        :title="t('st.run.reopen.title')"
        :message="t('st.run.reopen.confirmText')"
        :confirm-label="t('st.run.reopen.continue')"
        @confirm="onReopenReason"
        @close="reopenReasonOpen = false"
      />
      <PinDialog :open="reopenPinOpen" :title="t('st.run.reopen.pinTitle')" role="supervisor" @signed="onReopenSigned" @close="reopenPinOpen = false" />
      <ReasonDialog
        :open="takeoverOpen"
        :title="t('st.run.lock.takeOverTitle')"
        :message="t('st.run.lock.takeOverText', { name: lock.foreign.value ? registry.userName(lock.foreign.value.holder_user) : t('st.run.lock.someone') })"
        :confirm-label="t('st.run.lock.takeOver')"
        :reason-required="false"
        danger
        :busy="lock.state.value === 'acquiring'"
        :errors="takeoverErrors"
        @confirm="takeOver"
        @close="takeoverOpen = false"
      />
    </template>
  </div>
</template>

<style scoped>
.st-stepview__titlebar { align-items: baseline; }
.st-stepview__num { font-size: 1.5rem; font-weight: 700; color: var(--st-text-muted); }
.st-stepview__title { margin: 0; flex: 1; min-width: 12ch; }
.st-stepview__media { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--st-gap); }
.st-stepview__nav { margin-top: 8px; }
.st-md { font-size: 1.1rem; line-height: 1.55; }
.st-md :deep(img) { max-width: 100%; height: auto; }
.st-md :deep(table) { border-collapse: collapse; }
.st-md :deep(td), .st-md :deep(th) { border: 1px solid var(--st-border); padding: 6px 8px; }
.st-notes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.st-notes__item { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; background: var(--st-surface-2); border-radius: var(--st-radius); }
.st-notes__text { white-space: pre-wrap; word-break: break-word; }
</style>
