<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RevisionContent, Section, Workstation } from '../../domain/types'
import { moveStep, newStep, removeStep, stepNumbers } from './contentOps'
import type { Issue } from './validation'
import FieldIssues from './FieldIssues.vue'
import StepEditor from './StepEditor.vue'

const props = defineProps<{
  section: Section
  index: number
  content: RevisionContent
  issues: Issue[]
  workstations: Workstation[]
  expandedStep: string | null
  readonly?: boolean
}>()
const emit = defineEmits<{ move: [delta: -1 | 1]; remove: []; expand: [stepId: string | null] }>()
const { t } = useI18n()

const numbers = computed(() => stepNumbers(props.content))
const sectionIssues = computed(() => props.issues.filter((i) => i.sectionId === props.section.id && !i.stepId))
const isFirstSection = computed(() => props.index === 0)
const isLastSection = computed(() => props.index === props.content.sections.length - 1)

function addStep() {
  const s = newStep()
  props.section.steps.push(s)
  emit('expand', s.id)
}

function move(stepId: string, delta: -1 | 1) {
  moveStep(props.content, stepId, delta)
}
</script>

<template>
  <section class="st-sec-ed st-stack" :data-section="section.id">
    <div class="st-row st-sec-ed__head">
      <span class="st-mono st-sec-ed__num">{{ index + 1 }}</span>
      <label class="st-sec-ed__title">
        <span class="st-sr">{{ t('st.authoring.section.title') }}</span>
        <input
          v-model="section.title"
          class="st-input st-sec-ed__input"
          :readonly="readonly"
          :placeholder="t('st.authoring.section.titlePlaceholder')"
          :aria-label="t('st.authoring.section.title')"
          data-test="section-title"
        />
      </label>
      <template v-if="!readonly">
        <button type="button" class="st-btn" :disabled="isFirstSection" :aria-label="t('st.authoring.section.moveUp')" @click="emit('move', -1)">↑</button>
        <button type="button" class="st-btn" :disabled="isLastSection" :aria-label="t('st.authoring.section.moveDown')" @click="emit('move', 1)">↓</button>
        <button type="button" class="st-btn st-btn--ghost" data-test="section-remove" @click="emit('remove')">{{ t('st.authoring.section.remove') }}</button>
      </template>
    </div>
    <FieldIssues :issues="sectionIssues" />

    <StepEditor
      v-for="(st, i) in section.steps"
      :key="st.id"
      :step="st"
      :content="content"
      :number="numbers.get(st.id) ?? ''"
      :issues="issues"
      :workstations="workstations"
      :readonly="readonly"
      :expanded="expandedStep === st.id"
      :first="isFirstSection && i === 0"
      :last="isLastSection && i === section.steps.length - 1"
      @toggle="emit('expand', expandedStep === st.id ? null : st.id)"
      @move="(d) => move(st.id, d)"
      @remove="removeStep(content, st.id)"
    />
    <div v-if="!readonly">
      <button type="button" class="st-btn" data-test="add-step" @click="addStep">+ {{ t('st.authoring.section.addStep') }}</button>
    </div>
  </section>
</template>

<style scoped>
.st-sec-ed { padding: 12px 0 20px; border-bottom: 2px solid var(--st-border); }
.st-sec-ed__head { flex-wrap: nowrap; }
.st-sec-ed__num { font-size: 1.3rem; font-weight: 700; color: var(--st-text-muted); min-width: 1.5em; }
.st-sec-ed__title { flex: 1; min-width: 0; }
.st-sec-ed__input { font-size: 1.2rem; font-weight: 700; }
.st-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
