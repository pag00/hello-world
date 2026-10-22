<script setup lang="ts">
// One run: header, all steps with their state, offline checkout, NCRs, completion / abort.
import { computed, ref, toRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { BlockReason, Uuid } from '../domain/types'
import { parseQr } from '../domain/qr'
import { useRegistryStore, useRunsStore, useSessionStore } from '../stores'
import ScanButton from '../components/device/ScanButton.vue'
import CheckoutPanel from '../components/run/CheckoutPanel.vue'
import NcrRaiseDialog from '../components/run/NcrRaiseDialog.vue'
import QrResultPanel from '../components/run/QrResultPanel.vue'
import ReasonDialog from '../components/run/ReasonDialog.vue'
import RunHeader from '../components/run/RunHeader.vue'
import RunNcrList from '../components/run/RunNcrList.vue'
import StepStateBadge from '../components/run/StepStateBadge.vue'
import { deviceErrorText, errorLines } from '../components/run/errors'
import { fmtDateTime } from '../components/run/format'
import { resolveWorkstationInRun } from '../components/run/qrRouting'
import { isStepDone, nextStepId, pendingDependencies } from '../components/run/runNav'
import { useQrNavigation } from '../components/run/useQrNavigation'
import { useRunContext } from '../components/run/useRunContext'

const props = defineProps<{ runId: string }>()
const { t, locale } = useI18n()
const router = useRouter()
const runs = useRunsStore()
const registry = useRegistryStore()
const session = useSessionStore()
const qr = useQrNavigation()

const ctx = useRunContext(toRef(props, 'runId'))
const { loaded, run, revision, procedure, content, projection, steps, status, closed, progress, runEdit, now } = ctx

watch(
  [run, closed],
  ([r, c]) => {
    if (r && !c) runs.activeRunId = r.id
  },
  { immediate: true },
)

const next = computed(() => (closed.value ? null : nextStepId(content.value, projection.value)))
const nextRef = computed(() => steps.value.find((s) => s.step.id === next.value) ?? null)

const sections = computed(() =>
  (content.value?.sections ?? []).map((section) => ({
    section,
    steps: steps.value.filter((s) => s.section.id === section.id),
  })),
)

function stepState(id: Uuid) {
  return projection.value?.steps[id]?.state ?? 'pending'
}

function stepLocks(stepId: Uuid) {
  void now.value
  const nowIso = new Date().toISOString()
  return runs.locks(props.runId).filter((l) => l.step_id === stepId && l.expires_at > nowIso)
}

function lockLabel(stepId: Uuid): string | null {
  const l = stepLocks(stepId)[0]
  if (!l) return null
  return l.holder_device === session.deviceId ? t('st.run.lock.thisTablet') : t('st.run.lock.heldBy', { name: registry.userName(l.holder_user) })
}

function blockText(r: BlockReason) {
  return t(`st.run.block.${r}`)
}

function depsText(stepId: Uuid): string | null {
  const ref = steps.value.find((s) => s.step.id === stepId)
  if (!ref) return null
  const pending = pendingDependencies(ref.step, projection.value, steps.value)
  return pending.length ? t('st.run.dependsOn', { steps: pending.map((p) => `${p.number} ${p.step.title}`).join(', ') }) : null
}

function needsVerification(stepId: Uuid) {
  const ref = steps.value.find((s) => s.step.id === stepId)
  return !!ref?.step.verification?.required && stepState(stepId) === 'completed'
}

// ---- workstation scan inside this run
const scanMessage = ref<string | null>(null)
async function onScan(text: string) {
  scanMessage.value = null
  const target = parseQr(text)
  if (target.kind !== 'workstation' || !run.value) return qr.handle(target)
  const r = resolveWorkstationInRun(run.value, target.code, {
    runs: runs.runs, activeRunId: props.runId, deviceRunIds: new Set(),
    contentOf: () => content.value, projectionOf: () => projection.value,
  })
  if (r.type === 'navigate') return router.push(r.to)
  if (r.type === 'choose-step' && !r.stepIds.length) {
    scanMessage.value = t('st.run.scanNoStepHere', { code: target.code })
    return
  }
  qr.result.value = r
}
function onScanError(m: string) {
  scanMessage.value = deviceErrorText(m, t)
}

// ---- completion / abort
const canCompleteRole = computed(() => session.hasRole('inspector') || session.hasRole('supervisor'))
const isSupervisor = computed(() => session.hasRole('supervisor'))
const completeErrors = ref<string[]>([])
const completeBusy = ref(false)
const confirmComplete = ref(false)

const notCompleteReasons = computed(() => {
  const p = projection.value
  if (!p || p.can_complete) return []
  const out: string[] = []
  const open = steps.value.filter((s) => !isStepDone(s.step, p.steps[s.step.id]))
  const unverified = open.filter((s) => p.steps[s.step.id]?.state === 'completed')
  const notDone = open.length - unverified.length
  if (notDone) out.push(t('st.run.completeRun.stepsOpen', { n: notDone }, notDone))
  if (unverified.length) out.push(t('st.run.completeRun.stepsUnverified', { n: unverified.length }, unverified.length))
  if (p.open_ncr_ids.length) out.push(t('st.run.completeRun.openNcrs', { n: p.open_ncr_ids.length }, p.open_ncr_ids.length))
  if (steps.value.some((s) => p.steps[s.step.id]?.state === 'conflict')) out.push(t('st.run.completeRun.conflicts'))
  return out
})

async function completeRun() {
  confirmComplete.value = false
  completeBusy.value = true
  completeErrors.value = []
  try {
    await runs.completeRun(props.runId)
  } catch (e) {
    completeErrors.value = errorLines(e, t)
  } finally {
    completeBusy.value = false
  }
}

const abortOpen = ref(false)
const abortBusy = ref(false)
const abortErrors = ref<string[]>([])
async function abortRun(reason: string) {
  abortBusy.value = true
  abortErrors.value = []
  try {
    await runs.abortRun(props.runId, reason)
    abortOpen.value = false
  } catch (e) {
    abortErrors.value = errorLines(e, t)
  } finally {
    abortBusy.value = false
  }
}

const ncrOpen = ref(false)
</script>

<template>
  <div class="st-page st-stack st-runview">
    <p v-if="!loaded" class="st-muted">{{ t('st.common.loading') }}</p>
    <div v-else-if="!run" class="st-card st-stack" data-test="run-missing">
      <p class="st-alert st-alert--warn">{{ t('st.run.notOnDevice') }}</p>
      <RouterLink class="st-btn" :to="{ name: 'st-runs' }">{{ t('st.run.qr.allRuns') }}</RouterLink>
    </div>

    <template v-else>
      <section class="st-card st-stack">
        <RunHeader :run="run" :procedure="procedure" :revision="revision" :status="status" :progress="progress" />
        <div class="st-row st-noprint">
          <RouterLink
            v-if="nextRef"
            class="st-btn st-btn--primary st-btn--lg st-runview__next"
            :to="{ name: 'st-run-step', params: { runId: run.id, stepId: nextRef.step.id } }"
            data-test="next-step"
          >
            {{ t('st.run.nextStep', { step: `${nextRef.number} ${nextRef.step.title}` }) }}
          </RouterLink>
          <ScanButton v-if="!closed" :label="t('st.run.scanWorkstation')" size="lg" @scanned="onScan" @error="onScanError" />
          <span class="st-spacer" />
          <RouterLink class="st-btn" :to="{ name: 'st-run-record', params: { runId: run.id } }">{{ t('st.run.links.record') }}</RouterLink>
          <RouterLink class="st-btn" :to="{ name: 'st-run-traveller', params: { runId: run.id } }">{{ t('st.run.links.traveller') }}</RouterLink>
        </div>
        <p v-if="scanMessage" class="st-alert st-alert--warn" role="alert">{{ scanMessage }}</p>
      </section>

      <QrResultPanel v-if="qr.result.value" :result="qr.result.value" @choose-run="qr.chooseRun" @clear="qr.clear" />

      <p v-if="!runEdit.ok && runEdit.reason !== 'run_closed'" class="st-alert st-alert--warn" data-test="run-readonly">
        {{ t(`st.run.readOnly.${runEdit.reason}`) }}
      </p>
      <p v-if="status === 'blocked'" class="st-alert st-alert--danger">{{ t('st.run.blockedExplain') }}</p>
      <p v-if="status === 'completed'" class="st-alert st-alert--ok">{{ t('st.run.completedBanner', { time: fmtDateTime(run.closed_at, locale) }) }}</p>
      <p v-if="status === 'aborted'" class="st-alert st-alert--danger">{{ t('st.run.abortedBanner') }}</p>

      <section v-for="sec in sections" :key="sec.section.id" class="st-stack">
        <h2 class="st-h2 st-runview__section">{{ sec.section.title }}</h2>
        <ul class="st-steps">
          <li v-for="s in sec.steps" :key="s.step.id">
            <RouterLink
              :to="{ name: 'st-run-step', params: { runId: run.id, stepId: s.step.id } }"
              class="st-steps__row"
              :class="{ 'st-steps__row--next': s.step.id === next }"
              :data-test="`step-row-${s.step.id}`"
            >
              <span class="st-steps__num st-mono">{{ s.number }}</span>
              <span class="st-steps__main">
                <strong class="st-steps__title">{{ s.step.title }}</strong>
                <span v-if="projection?.steps[s.step.id]?.block_reasons.length" class="st-steps__reasons">
                  <span v-for="r in projection.steps[s.step.id]!.block_reasons" :key="r" class="st-badge st-badge--warn">{{ blockText(r) }}</span>
                </span>
                <span v-if="depsText(s.step.id)" class="st-hint">{{ depsText(s.step.id) }}</span>
                <span v-if="stepState(s.step.id) === 'conflict'" class="st-hint st-steps__danger">{{ t('st.run.conflictHint') }}</span>
                <span v-if="needsVerification(s.step.id)" class="st-hint">
                  {{ t('st.run.awaitsVerification', { role: t(`st.session.roles.${s.step.verification!.role}`) }) }}
                </span>
                <span v-if="projection?.steps[s.step.id]?.completed_by" class="st-hint">
                  {{ t('st.run.completedBy', { name: registry.userName(projection.steps[s.step.id]!.completed_by), time: fmtDateTime(projection.steps[s.step.id]!.completed_at, locale) }) }}
                  <template v-if="projection.steps[s.step.id]!.verified_by">
                    · {{ t('st.run.verifiedBy', { name: registry.userName(projection.steps[s.step.id]!.verified_by), time: fmtDateTime(projection.steps[s.step.id]!.verified_at, locale) }) }}
                  </template>
                </span>
              </span>
              <span class="st-steps__side">
                <StepStateBadge :state="stepState(s.step.id)" />
                <span v-if="lockLabel(s.step.id)" class="st-badge st-badge--info" data-test="lock-holder">{{ lockLabel(s.step.id) }}</span>
                <span v-if="s.step.verification?.required" class="st-hint">{{ t('st.run.verificationRequired') }}</span>
                <span v-if="s.step.locations.length" class="st-hint st-mono">{{ s.step.locations.join(', ') }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </section>

      <CheckoutPanel :run-id="run.id" :closed="closed" />

      <RunNcrList :run-id="run.id" :content="content" :can-raise="runEdit.ok" @raise="ncrOpen = true" />

      <section v-if="!closed && (canCompleteRole || isSupervisor)" class="st-card st-stack" data-test="run-close">
        <h2 class="st-h2">{{ t('st.run.completeRun.title') }}</h2>
        <template v-if="canCompleteRole">
          <ul v-if="notCompleteReasons.length" class="st-runview__reasons" data-test="complete-run-reasons">
            <li v-for="r in notCompleteReasons" :key="r">{{ r }}</li>
          </ul>
          <p v-else class="st-alert st-alert--ok">{{ t('st.run.completeRun.ready') }}</p>
          <div>
            <button
              type="button"
              class="st-btn st-btn--primary st-btn--lg"
              :disabled="!projection?.can_complete || !runEdit.ok || completeBusy"
              data-test="complete-run"
              @click="confirmComplete = true"
            >
              {{ t('st.run.completeRun.button') }}
            </button>
          </div>
          <p v-for="e in completeErrors" :key="e" class="st-alert st-alert--danger" role="alert">{{ e }}</p>
        </template>
        <div v-if="isSupervisor">
          <button type="button" class="st-btn st-btn--danger" :disabled="!runEdit.ok" data-test="abort-run" @click="abortOpen = true">
            {{ t('st.run.abort.button') }}
          </button>
        </div>
      </section>

      <ReasonDialog
        :open="confirmComplete"
        :title="t('st.run.completeRun.confirmTitle')"
        :message="t('st.run.completeRun.confirmText', { serial: run.serial })"
        :confirm-label="t('st.run.completeRun.button')"
        :reason-required="false"
        @confirm="completeRun"
        @close="confirmComplete = false"
      />
      <ReasonDialog
        :open="abortOpen"
        :title="t('st.run.abort.title')"
        :message="t('st.run.abort.text')"
        :confirm-label="t('st.run.abort.button')"
        danger
        :busy="abortBusy"
        :errors="abortErrors"
        @confirm="abortRun"
        @close="abortOpen = false"
      />
      <NcrRaiseDialog :open="ncrOpen" :run-id="run.id" :step-id="null" :context="t('st.run.ncr.runLevelContext')" @close="ncrOpen = false" />
    </template>
  </div>
</template>

<style scoped>
.st-runview__next { flex: 1; min-width: 260px; text-decoration: none; }
.st-runview__section { margin-top: 8px; }
.st-runview__reasons { margin: 0; padding-left: 22px; color: var(--st-warn); font-weight: 600; }
.st-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.st-steps__row {
  display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; min-height: 64px;
  background: var(--st-surface); border: 1px solid var(--st-border); border-radius: var(--st-radius);
  color: inherit; text-decoration: none;
}
.st-steps__row--next { border-color: var(--st-primary); box-shadow: 0 0 0 2px var(--st-primary); }
.st-steps__num { font-size: 1.1rem; font-weight: 700; min-width: 3.2ch; padding-top: 2px; }
.st-steps__main { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.st-steps__title { font-size: 1.1rem; }
.st-steps__reasons { display: flex; flex-wrap: wrap; gap: 4px; }
.st-steps__danger { color: var(--st-danger); }
.st-steps__side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; text-align: right; }
</style>
