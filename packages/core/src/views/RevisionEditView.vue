<script setup lang="ts">
// Draft revision editor. Edits a local copy; nothing reaches the server until the explicit Save
// (online only, draft content is server-side state). Leaving with unsaved changes asks first.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { RevisionContent } from '../domain/types'
import { canonicalJson } from '../domain/canonical'
import { useProceduresStore, useRegistryStore, useSessionStore, useSyncStore } from '../stores'
import StDialog from '../components/StDialog.vue'
import RevisionStatusBadge from '../components/authoring/RevisionStatusBadge.vue'
import SectionEditor from '../components/authoring/SectionEditor.vue'
import IssueList from '../components/authoring/IssueList.vue'
import { cleanContent, moveItem, newSection, removeSection } from '../components/authoring/contentOps'
import { canSubmit, hasErrors, validateContent } from '../components/authoring/validation'
import { errorText } from '../components/authoring/errors'

const props = defineProps<{ revisionId: string }>()
const { t } = useI18n()
const procedures = useProceduresStore()
const registry = useRegistryStore()
const session = useSessionStore()
const sync = useSyncStore()

const revision = computed(() => procedures.getRevision(props.revisionId))
const procedure = computed(() => procedures.procedures.find((p) => p.id === revision.value?.procedure_id) ?? null)
const readonly = computed(() => revision.value?.status !== 'draft' || !session.hasRole('author'))

function clone(c: RevisionContent): RevisionContent {
  return JSON.parse(JSON.stringify(c)) as RevisionContent
}
function fingerprint(c: RevisionContent): string {
  const clean = cleanContent(c)
  try {
    return canonicalJson(clean)
  } catch {
    // NaN/float typed into an integer field: not canonical, but certainly a change
    return 'invalid:' + JSON.stringify(clean)
  }
}

const draft = ref<RevisionContent | null>(null)
const savedPrint = ref('')
function load() {
  const rev = revision.value
  if (!rev) return
  draft.value = clone(rev.content ?? { schema: 1, sections: [] })
  savedPrint.value = fingerprint(draft.value)
}
load()

const dirty = computed(() => !!draft.value && !readonly.value && fingerprint(draft.value) !== savedPrint.value)

// a pull may bring a newer copy (another author saved, or the revision left draft); adopt it unless
// we would throw away local edits
watch(
  () => revision.value && [revision.value.content, revision.value.status],
  () => {
    if (!draft.value || !dirty.value) load()
  },
)

const issues = computed(() => {
  if (!draft.value) return []
  const ws = registry.workstations.map((w) => w.code)
  return validateContent(cleanContent(draft.value), ws.length ? { workstations: ws } : {})
})
const blocking = computed(() => hasErrors(issues.value))
const readyForReview = computed(() => canSubmit(issues.value))

// ---- structure
const expandedStep = ref<string | null>(null)
function addSection() {
  if (!draft.value) return
  draft.value.sections.push(newSection())
}
function removeSec(id: string) {
  if (draft.value) removeSection(draft.value, id)
}
async function focusStep(stepId: string) {
  expandedStep.value = stepId
  await nextTick()
  document.querySelector(`[data-step="${stepId}"]`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

// ---- save
const saving = ref(false)
const saveError = ref<string | null>(null)
const savedAt = ref<string | null>(null)

async function save() {
  if (!draft.value || readonly.value || saving.value) return
  saveError.value = null
  if (blocking.value) {
    saveError.value = t('st.authoring.editor.fixErrors')
    return
  }
  if (!session.online) {
    saveError.value = t('st.authoring.errors.offline')
    return
  }
  saving.value = true
  try {
    const content = cleanContent(draft.value)
    const hasMedia = content.sections.some((s) => s.steps.some((st) => st.media.length))
    if (hasMedia && sync.pendingBlobs > 0) {
      // reference images are queued blobs; upload them first so the saved draft never points at
      // bytes the server does not have (best effort — the blob queue retries anyway)
      await sync.syncNow().catch(() => undefined)
    }
    const saved = await procedures.saveDraft(props.revisionId, content)
    draft.value = clone(saved.content)
    savedPrint.value = fingerprint(draft.value)
    savedAt.value = new Date().toLocaleTimeString()
  } catch (e) {
    saveError.value = errorText(e, t)
  } finally {
    saving.value = false
  }
}

function discard() {
  load()
  saveError.value = null
}

// ---- unsaved-changes guard
const leaveDialog = ref(false)
let leaveResolve: ((ok: boolean) => void) | null = null
function answerLeave(ok: boolean) {
  leaveDialog.value = false
  leaveResolve?.(ok)
  leaveResolve = null
}
function confirmLeave(): true | Promise<boolean> {
  if (!dirty.value) return true
  leaveDialog.value = true
  return new Promise<boolean>((resolve) => (leaveResolve = resolve))
}
onBeforeRouteLeave(confirmLeave)
// same view reused for another revision (param change) — guard it like a leave
onBeforeRouteUpdate((to, from) => (to.params.revisionId !== from.params.revisionId ? confirmLeave() : true))
watch(
  () => props.revisionId,
  () => {
    expandedStep.value = null
    saveError.value = null
    savedAt.value = null
    load()
  },
)
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  answerLeave(false)
})

function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    void save()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="st-page st-stack st-rev-edit">
    <template v-if="revision && draft">
      <header class="st-stack">
        <RouterLink v-if="procedure" :to="{ name: 'st-procedure', params: { procedureId: procedure.id } }" class="st-rev-edit__back">
          ← {{ procedure.number }} {{ procedure.title }}
        </RouterLink>
        <div class="st-row">
          <h1 class="st-h1">{{ t('st.authoring.editor.title', { rev: revision.rev }) }}</h1>
          <RevisionStatusBadge :status="revision.status" />
        </div>
        <p v-if="revision.change_reason" class="st-muted">
          <strong>{{ t('st.authoring.revision.changeReason') }}:</strong> {{ revision.change_reason }}
        </p>
        <p v-if="revision.status !== 'draft'" class="st-alert st-alert--info" data-test="readonly-note">{{ t('st.authoring.editor.readonlyStatus') }}</p>
        <p v-else-if="readonly" class="st-alert st-alert--info" data-test="readonly-note">{{ t('st.authoring.editor.readonlyRole') }}</p>
        <p v-else-if="!session.online" class="st-alert st-alert--warn">{{ t('st.authoring.editor.offlineHint') }}</p>
      </header>

      <div v-if="!readonly" class="st-rev-edit__bar st-card st-row st-noprint">
        <span v-if="dirty" class="st-badge st-badge--warn" data-test="dirty">{{ t('st.authoring.editor.unsaved') }}</span>
        <span v-else-if="savedAt" class="st-badge st-badge--ok">{{ t('st.authoring.editor.savedAt', { time: savedAt }) }}</span>
        <span v-if="readyForReview" class="st-hint">{{ t('st.authoring.editor.readyForReview') }}</span>
        <span class="st-spacer" />
        <button type="button" class="st-btn" :disabled="!dirty || saving" @click="discard">{{ t('st.authoring.editor.discard') }}</button>
        <button
          type="button"
          class="st-btn st-btn--primary"
          :disabled="!dirty || saving || blocking || !session.online"
          data-test="save"
          @click="save"
        >
          {{ saving ? t('st.common.loading') : t('st.common.save') }}
        </button>
      </div>
      <p v-if="saveError" class="st-alert st-alert--danger" role="alert" data-test="save-error">{{ saveError }}</p>

      <details v-if="issues.length" class="st-card" :open="blocking">
        <summary class="st-rev-edit__summary">{{ t('st.authoring.editor.issuesTitle', { n: issues.length }, issues.length) }}</summary>
        <IssueList :issues="issues" :content="draft" @focus="focusStep" />
      </details>

      <p v-if="!draft.sections.length" class="st-muted">{{ t('st.authoring.editor.empty') }}</p>
      <SectionEditor
        v-for="(sec, i) in draft.sections"
        :key="sec.id"
        :section="sec"
        :index="i"
        :content="draft"
        :issues="issues"
        :workstations="registry.workstations"
        :expanded-step="expandedStep"
        :readonly="readonly"
        @move="(d) => moveItem(draft!.sections, i, d)"
        @remove="removeSec(sec.id)"
        @expand="(id) => (expandedStep = id)"
      />
      <div v-if="!readonly">
        <button type="button" class="st-btn st-btn--lg" data-test="add-section" @click="addSection">+ {{ t('st.authoring.editor.addSection') }}</button>
      </div>
    </template>
    <p v-else class="st-alert st-alert--warn">{{ t('st.authoring.revision.notFound') }}</p>

    <StDialog :open="leaveDialog" :title="t('st.authoring.editor.leaveTitle')" @close="answerLeave(false)">
      <p>{{ t('st.authoring.editor.leaveBody') }}</p>
      <template #actions>
        <button type="button" class="st-btn" data-test="leave-stay" @click="answerLeave(false)">{{ t('st.authoring.editor.stay') }}</button>
        <button type="button" class="st-btn st-btn--danger" data-test="leave-discard" @click="answerLeave(true)">{{ t('st.authoring.editor.leaveDiscard') }}</button>
      </template>
    </StDialog>
  </div>
</template>

<style scoped>
.st-rev-edit__back { color: var(--st-primary); text-decoration: none; font-weight: 600; min-height: var(--st-touch); display: inline-flex; align-items: center; }
.st-rev-edit__bar { position: sticky; top: 60px; z-index: 5; padding: 8px 12px; }
.st-rev-edit__summary { cursor: pointer; font-weight: 700; min-height: var(--st-touch); display: flex; align-items: center; }
</style>
