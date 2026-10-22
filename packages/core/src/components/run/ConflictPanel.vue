<script setup lang="ts">
// A step in conflict: records from different devices/people that the server could not order safely (§6).
// Everyone sees the competing records; a supervisor chooses which to keep. Nothing is deleted — rejected
// records stay in the ledger and the as-run record, they just stop counting.
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { deadEventIds } from '../../domain/projection'
import type { InputValue, RunEvent, Step, Uuid } from '../../domain/types'
import { useRegistryStore, useRunsStore, useSessionStore } from '../../stores'
import { errorLines } from './errors'
import { fmtDateTime } from './format'

const props = defineProps<{ runId: Uuid; step: Step }>()
const { t, locale } = useI18n()
const runs = useRunsStore()
const registry = useRegistryStore()
const session = useSessionStore()

interface Group {
  key: string
  title: string
  /** competing values for one input: exactly one may be kept */
  exclusive: boolean
  events: RunEvent[]
}

const groups = computed<Group[]>(() => {
  const all = runs.events(props.runId)
  const dead = deadEventIds(all)
  const mine = all.filter((e) => e.step_id === props.step.id)
  let lastResolved = -1
  mine.forEach((e, i) => {
    if (e.type === 'conflict.resolved' && !dead.has(e.id)) lastResolved = i
  })
  const open = mine.slice(lastResolved + 1).filter((e) => !dead.has(e.id) && e.type !== 'note.added' && e.type !== 'conflict.resolved')
  const out: Group[] = []
  for (const input of props.step.inputs) {
    const evs = open.filter((e) => e.type === 'input.recorded' && (e as RunEvent<'input.recorded'>).payload.input_id === input.id)
    if (evs.length > 1 || evs.some((e) => e.flags?.includes('conflict'))) {
      out.push({ key: input.id, title: input.label, exclusive: evs.length > 1, events: evs })
    }
  }
  const other = open.filter((e) => e.type !== 'input.recorded' && e.flags?.includes('conflict'))
  if (other.length) out.push({ key: 'step', title: t('st.run.conflict.stepRecords'), exclusive: false, events: other })
  return out
})

/** per group: exclusive → kept event id; otherwise per event keep flag */
const choice = reactive<Record<string, Uuid | null>>({})
const keepFlags = reactive<Record<Uuid, boolean>>({})
const reason = ref('')
const busy = ref(false)
const errors = ref<string[]>([])

watch(
  groups,
  (gs) => {
    for (const g of gs) {
      if (g.exclusive && !(g.key in choice)) choice[g.key] = null
      if (!g.exclusive) for (const e of g.events) if (!(e.id in keepFlags)) keepFlags[e.id] = true
    }
  },
  { immediate: true },
)

const isSupervisor = computed(() => session.hasRole('supervisor'))
const complete = computed(() => groups.value.every((g) => !g.exclusive || !!choice[g.key]))

const decision = computed(() => {
  const keep: Uuid[] = []
  const reject: Uuid[] = []
  for (const g of groups.value) {
    for (const e of g.events) {
      const kept = g.exclusive ? choice[g.key] === e.id : keepFlags[e.id] !== false
      ;(kept ? keep : reject).push(e.id)
    }
  }
  return { keep, reject }
})

function valueText(v: InputValue, step: Step, inputId: Uuid): string {
  const input = step.inputs.find((i) => i.id === inputId)
  if (v === true) return t('st.run.value.yes')
  if (Array.isArray(v)) return t('st.run.value.photos', { n: v.length }, v.length)
  return input?.type === 'number' ? `${v} ${input.unit}` : v
}

function describe(e: RunEvent): string {
  if (e.type === 'input.recorded') {
    const p = (e as RunEvent<'input.recorded'>).payload
    return valueText(p.value, props.step, p.input_id)
  }
  return t(`st.run.eventType.${e.type.replace('.', '_')}`)
}

async function submit() {
  if (!complete.value || !reason.value.trim() || busy.value) return
  busy.value = true
  errors.value = []
  try {
    const d = decision.value
    await runs.resolveConflict({ runId: props.runId, stepId: props.step.id, keep: d.keep, reject: d.reject, reason: reason.value })
    reason.value = ''
  } catch (e) {
    errors.value = errorLines(e, t)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="st-card st-stack st-conflict" data-test="conflict-panel">
    <h2 class="st-h2">{{ t('st.run.conflict.title') }}</h2>
    <p class="st-alert st-alert--danger">{{ t('st.run.conflict.explain') }}</p>
    <p v-if="!groups.length" class="st-muted">{{ t('st.run.conflict.noneFound') }}</p>

    <fieldset v-for="g in groups" :key="g.key" class="st-conflict__group">
      <legend class="st-label">{{ g.title }}</legend>
      <p v-if="g.exclusive && isSupervisor" class="st-hint">{{ t('st.run.conflict.pickOne') }}</p>
      <label v-for="e in g.events" :key="e.id" class="st-conflict__event" :data-test="`conflict-event-${e.id}`">
        <template v-if="isSupervisor">
          <input v-if="g.exclusive" v-model="choice[g.key]" type="radio" :name="`st-conflict-${g.key}`" :value="e.id" class="st-conflict__pick" />
          <input v-else v-model="keepFlags[e.id]" type="checkbox" class="st-conflict__pick" />
        </template>
        <span class="st-conflict__body">
          <strong class="st-mono st-conflict__value">{{ describe(e) }}</strong>
          <span class="st-muted">
            {{ t('st.run.meta.by', { name: registry.userName(e.actor_id), time: fmtDateTime(e.client_ts, locale) }) }}
            · {{ t('st.run.conflict.device', { id: e.device_id.slice(-8) }) }}
            <template v-if="e.offline"> · {{ t('st.run.meta.offline') }}</template>
          </span>
          <span v-if="e.flags?.length" class="st-row st-conflict__flags">
            <span v-for="fl in e.flags" :key="fl" class="st-badge st-badge--warn">{{ t(`st.run.flag.${fl}`) }}</span>
          </span>
        </span>
      </label>
    </fieldset>

    <template v-if="isSupervisor && groups.length">
      <label class="st-stack">
        <span class="st-label">{{ t('st.run.reason.label') }}</span>
        <textarea v-model="reason" class="st-textarea" rows="3" data-test="conflict-reason" />
      </label>
      <p v-for="e in errors" :key="e" class="st-alert st-alert--danger" role="alert">{{ e }}</p>
      <div>
        <button
          type="button"
          class="st-btn st-btn--primary"
          :disabled="!complete || !reason.trim() || busy"
          data-test="conflict-resolve"
          @click="submit"
        >
          {{ t('st.run.conflict.resolve', { keep: decision.keep.length, reject: decision.reject.length }) }}
        </button>
      </div>
    </template>
    <p v-else-if="!isSupervisor" class="st-hint">{{ t('st.run.conflict.supervisorOnly') }}</p>
  </section>
</template>

<style scoped>
.st-conflict__group { border: 1px solid var(--st-border); border-radius: var(--st-radius); padding: 10px 12px; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.st-conflict__event { display: flex; gap: 12px; align-items: flex-start; padding: 8px; border-radius: var(--st-radius); background: var(--st-surface-2); cursor: pointer; min-height: var(--st-touch); }
.st-conflict__pick { width: 28px; height: 28px; flex: none; margin-top: 2px; }
.st-conflict__body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.st-conflict__value { font-size: 1.2rem; word-break: break-word; }
.st-conflict__flags { gap: 4px; }
</style>
