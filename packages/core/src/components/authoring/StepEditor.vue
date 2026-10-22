<script setup lang="ts">
// Editor for one step: title, instructions, reference media, workstation locations, dependencies,
// verification and inputs. Collapsible so long procedures stay navigable on a tablet.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InputType, RevisionContent, Role, Step, Workstation } from '../../domain/types'
import { INPUT_TYPES, changeInputType, moveItem, newInput, stepNumbers } from './contentOps'
import { wouldCreateCycle } from './graph'
import { ROLES, type Issue } from './validation'
import FieldIssues from './FieldIssues.vue'
import InputEditor from './InputEditor.vue'
import MarkdownField from './MarkdownField.vue'
import MediaEditor from './MediaEditor.vue'

const props = defineProps<{
  step: Step
  content: RevisionContent
  number: string
  issues: Issue[]
  workstations: Workstation[]
  readonly?: boolean
  expanded?: boolean
  first?: boolean
  last?: boolean
}>()
const emit = defineEmits<{ toggle: []; move: [delta: -1 | 1]; remove: [] }>()
const { t } = useI18n()

const mine = computed(() => props.issues.filter((i) => i.stepId === props.step.id))
const stepOnly = computed(() => mine.value.filter((i) => !i.inputId))
const errorCount = computed(() => mine.value.filter((i) => i.severity !== 'warning').length)
const warnCount = computed(() => mine.value.filter((i) => i.severity === 'warning').length)
const fid = (f: string) => `st-step-${props.step.id}-${f}`

// ---- dependencies
const numbers = computed(() => stepNumbers(props.content))
const otherSteps = computed(() =>
  props.content.sections.flatMap((s) => s.steps).filter((s) => s.id !== props.step.id),
)
function depBlocked(id: string) {
  // already-selected deps stay toggleable so an existing cycle can be broken from either side
  return !props.step.depends_on.includes(id) && wouldCreateCycle(props.content, props.step.id, id)
}
function toggleDep(id: string, on: boolean) {
  if (on) {
    if (depBlocked(id) || props.step.depends_on.includes(id)) return
    props.step.depends_on.push(id)
  } else {
    props.step.depends_on = props.step.depends_on.filter((d) => d !== id)
  }
}
const danglingDeps = computed(() => props.step.depends_on.filter((d) => !otherSteps.value.some((s) => s.id === d)))

// ---- locations
const unknownLocations = computed(() => props.step.locations.filter((c) => !props.workstations.some((w) => w.code === c)))
function toggleLocation(code: string, on: boolean) {
  if (on && !props.step.locations.includes(code)) props.step.locations.push(code)
  else if (!on) props.step.locations = props.step.locations.filter((c) => c !== code)
}

// ---- verification
const verificationRequired = computed(() => !!props.step.verification?.required)
function setVerification(required: boolean) {
  props.step.verification = required ? { required: true, role: props.step.verification?.role ?? 'inspector' } : null
}
function setVerificationRole(role: string) {
  if (props.step.verification) props.step.verification.role = role as Role
}

// ---- inputs
function addInput(type: InputType) {
  props.step.inputs.push(newInput(type))
}
function removeInput(i: number) {
  props.step.inputs.splice(i, 1)
}
</script>

<template>
  <article class="st-step-ed st-card" :data-step="step.id" :class="{ 'st-step-ed--open': expanded }">
    <header class="st-row st-step-ed__head">
      <button
        type="button"
        class="st-btn st-btn--ghost st-step-ed__toggle"
        :aria-expanded="!!expanded"
        :aria-controls="fid('body')"
        data-test="step-toggle"
        @click="emit('toggle')"
      >
        <span class="st-mono st-step-ed__num">{{ number }}</span>
        <span class="st-step-ed__title">{{ step.title || t('st.authoring.editor.untitledStep') }}</span>
      </button>
      <span v-if="errorCount" class="st-badge st-badge--danger">{{ t('st.authoring.editor.issueCount', { n: errorCount }, errorCount) }}</span>
      <span v-if="warnCount" class="st-badge st-badge--warn">{{ t('st.authoring.editor.warningCount', { n: warnCount }, warnCount) }}</span>
      <span v-if="step.verification?.required" class="st-badge st-badge--info">{{ t('st.authoring.step.verificationBadge') }}</span>
      <span v-for="c in step.locations" :key="c" class="st-badge st-mono">{{ c }}</span>
      <span class="st-spacer" />
      <template v-if="!readonly">
        <button type="button" class="st-btn" :disabled="first" :aria-label="t('st.authoring.editor.moveUp')" data-test="step-up" @click="emit('move', -1)">↑</button>
        <button type="button" class="st-btn" :disabled="last" :aria-label="t('st.authoring.editor.moveDown')" data-test="step-down" @click="emit('move', 1)">↓</button>
      </template>
    </header>

    <div v-if="expanded" :id="fid('body')" class="st-stack st-step-ed__body">
      <label>
        <span class="st-label">{{ t('st.authoring.step.title') }}</span>
        <input :id="fid('title')" v-model="step.title" class="st-input" :readonly="readonly" data-test="step-title" />
        <FieldIssues :issues="stepOnly" field="title" />
      </label>

      <div>
        <label class="st-label" :for="fid('instr')">{{ t('st.authoring.step.instructions') }}</label>
        <MarkdownField :id="fid('instr')" v-model="step.instructions" :readonly="readonly" />
      </div>

      <div>
        <span class="st-label">{{ t('st.authoring.step.media') }}</span>
        <MediaEditor :media="step.media" :readonly="readonly" />
      </div>

      <fieldset class="st-step-ed__set">
        <legend class="st-label">{{ t('st.authoring.step.locations') }}</legend>
        <p v-if="!workstations.length && !step.locations.length" class="st-muted">{{ t('st.authoring.step.noWorkstations') }}</p>
        <div class="st-step-ed__chips">
          <label v-for="w in workstations" :key="w.code" class="st-chip" :class="{ 'st-chip--on': step.locations.includes(w.code) }">
            <input
              type="checkbox"
              :checked="step.locations.includes(w.code)"
              :disabled="readonly"
              @change="toggleLocation(w.code, ($event.target as HTMLInputElement).checked)"
            />
            <span class="st-mono">{{ w.code }}</span> <span class="st-muted">{{ w.name }}</span>
          </label>
          <label v-for="c in unknownLocations" :key="c" class="st-chip st-chip--on st-chip--warn">
            <input type="checkbox" checked :disabled="readonly" @change="toggleLocation(c, false)" />
            <span class="st-mono">{{ c }}</span>
          </label>
        </div>
        <FieldIssues :issues="stepOnly" field="locations" />
      </fieldset>

      <fieldset class="st-step-ed__set">
        <legend class="st-label">{{ t('st.authoring.step.dependsOn') }}</legend>
        <p class="st-hint">{{ t('st.authoring.step.dependsOnHint') }}</p>
        <p v-if="!otherSteps.length" class="st-muted">{{ t('st.authoring.step.noOtherSteps') }}</p>
        <div class="st-step-ed__deps">
          <label
            v-for="s in otherSteps"
            :key="s.id"
            class="st-chip"
            :class="{ 'st-chip--on': step.depends_on.includes(s.id), 'st-chip--disabled': depBlocked(s.id) }"
            :title="depBlocked(s.id) ? t('st.authoring.step.wouldCycle') : undefined"
            :data-dep="s.id"
          >
            <input
              type="checkbox"
              :checked="step.depends_on.includes(s.id)"
              :disabled="readonly || depBlocked(s.id)"
              @change="toggleDep(s.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="st-mono">{{ numbers.get(s.id) }}</span>
            <span>{{ s.title || t('st.authoring.editor.untitledStep') }}</span>
            <span v-if="depBlocked(s.id)" class="st-hint">({{ t('st.authoring.step.wouldCycleShort') }})</span>
          </label>
          <label v-for="d in danglingDeps" :key="d" class="st-chip st-chip--on st-chip--warn">
            <input type="checkbox" checked :disabled="readonly" @change="toggleDep(d, false)" />
            <span>{{ t('st.authoring.step.missingStep') }}</span>
          </label>
        </div>
        <FieldIssues :issues="stepOnly" field="depends_on" />
      </fieldset>

      <fieldset class="st-step-ed__set">
        <legend class="st-label">{{ t('st.authoring.step.verification') }}</legend>
        <div class="st-row">
          <label class="st-row st-step-ed__check">
            <input
              type="checkbox"
              class="st-check"
              :checked="verificationRequired"
              :disabled="readonly"
              data-test="verification-required"
              @change="setVerification(($event.target as HTMLInputElement).checked)"
            />
            {{ t('st.authoring.step.verificationRequired') }}
          </label>
          <label v-if="verificationRequired" class="st-row">
            <span>{{ t('st.authoring.step.verificationRole') }}</span>
            <select
              class="st-select st-step-ed__role"
              :value="step.verification?.role"
              :disabled="readonly"
              @change="setVerificationRole(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="r in ROLES" :key="r" :value="r">{{ t(`st.authoring.roles.${r}`) }}</option>
            </select>
          </label>
        </div>
        <FieldIssues :issues="stepOnly" field="verification" />
      </fieldset>

      <section class="st-stack">
        <h4 class="st-label">{{ t('st.authoring.step.inputs') }}</h4>
        <p v-if="!step.inputs.length" class="st-muted">{{ t('st.authoring.step.noInputs') }}</p>
        <InputEditor
          v-for="(inp, i) in step.inputs"
          :key="inp.id"
          :input="inp"
          :issues="mine"
          :readonly="readonly"
          :first="i === 0"
          :last="i === step.inputs.length - 1"
          @remove="removeInput(i)"
          @move="(d) => moveItem(step.inputs, i, d)"
          @change-type="(ty) => changeInputType(step, inp.id, ty)"
        />
        <div v-if="!readonly" class="st-row">
          <span class="st-hint">{{ t('st.authoring.step.addInput') }}</span>
          <button
            v-for="ty in INPUT_TYPES"
            :key="ty"
            type="button"
            class="st-btn"
            :data-test="`add-input-${ty}`"
            @click="addInput(ty)"
          >
            + {{ t(`st.authoring.input.types.${ty}`) }}
          </button>
        </div>
      </section>

      <FieldIssues :issues="stepOnly" exact />

      <div v-if="!readonly" class="st-row">
        <span class="st-spacer" />
        <button type="button" class="st-btn st-btn--danger" data-test="step-remove" @click="emit('remove')">{{ t('st.authoring.step.remove') }}</button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.st-step-ed { padding: 10px 12px; }
.st-step-ed--open { border-color: var(--st-primary); }
.st-step-ed__head { gap: 8px; }
.st-step-ed__toggle { justify-content: flex-start; text-align: left; flex: 1 1 280px; min-width: 0; padding: 0 8px; }
.st-step-ed__num { color: var(--st-text-muted); margin-right: 6px; }
.st-step-ed__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-step-ed__body { padding-top: 12px; }
.st-step-ed__set { border: 0; padding: 0; margin: 0; }
.st-step-ed__chips, .st-step-ed__deps { display: flex; flex-wrap: wrap; gap: 8px; }
.st-step-ed__check { min-height: var(--st-touch); gap: 8px; font-weight: 600; cursor: pointer; }
.st-step-ed__role { width: auto; }
.st-check { width: 26px; height: 26px; }
.st-chip {
  display: inline-flex; align-items: center; gap: 8px; min-height: var(--st-touch); padding: 0 12px;
  border: 1px solid var(--st-border); border-radius: 999px; background: var(--st-surface); cursor: pointer;
}
.st-chip input { width: 22px; height: 22px; }
.st-chip--on { border-color: var(--st-primary); background: var(--st-info-bg); }
.st-chip--warn { border-color: var(--st-warn); background: var(--st-warn-bg); }
.st-chip--disabled { opacity: 0.55; cursor: not-allowed; }
</style>
