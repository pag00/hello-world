<script setup lang="ts">
// One procedure: revision history and the review workflow (ARCHITECTURE §3.1). Every transition is
// online-only and re-checked by the server; the UI only offers what the user's roles allow.
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { ProcedureRevision } from '../domain/types'
import { useProceduresStore, useRegistryStore, useSessionStore } from '../stores'
import StDialog from '../components/StDialog.vue'
import RevisionStatusBadge from '../components/authoring/RevisionStatusBadge.vue'
import RevisionDiff from '../components/authoring/RevisionDiff.vue'
import ApprovalHistory from '../components/authoring/ApprovalHistory.vue'
import { baselineOf, canCreateRevision, revisionActions, shortHash, sortRevisions } from '../components/authoring/revisions'
import { canSubmit, validateContent } from '../components/authoring/validation'
import { verifyRevisionHash } from '../components/quality/recordVerify'
import { errorText } from '../components/authoring/errors'
import { fmtDateTime } from '../components/run/format'

const props = defineProps<{ procedureId: string }>()
const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const procedures = useProceduresStore()
const registry = useRegistryStore()
const session = useSessionStore()

const procedure = computed(() => procedures.procedures.find((p) => p.id === props.procedureId) ?? null)
const revisions = computed(() => sortRevisions(procedures.revisionsOf(props.procedureId)))
const newestFirst = computed(() => [...revisions.value].reverse())

function defaultSelection(): string | null {
  const list = revisions.value
  const q = typeof route.query.rev === 'string' ? list.find((r) => r.id === route.query.rev) : null
  return (q ?? list.find((r) => r.status === 'in_review') ?? list.find((r) => r.status === 'draft') ?? list[list.length - 1])?.id ?? null
}
const selectedId = ref<string | null>(defaultSelection())
watch(revisions, () => {
  if (!selectedId.value || !revisions.value.some((r) => r.id === selectedId.value)) selectedId.value = defaultSelection()
})
const selected = computed(() => revisions.value.find((r) => r.id === selectedId.value) ?? null)
function select(r: ProcedureRevision) {
  selectedId.value = r.id
  void router.replace({ query: { ...route.query, rev: r.id } })
}

const baseline = computed(() => (selected.value ? baselineOf(selected.value, revisions.value) : null))
const actions = computed(() => (selected.value ? revisionActions(selected.value, revisions.value, session.user, session.online) : null))
const isOwnReview = computed(() => selected.value?.status === 'in_review' && selected.value.author_id === session.user?.id)
const stepCount = (r: ProcedureRevision) => r.content.sections.reduce((n, s) => n + s.steps.length, 0)

// stored content must still hash to the frozen content_hash; a mismatch means the cache is corrupt
const hashCheck = ref<boolean | null>(null)
watch(
  selected,
  async (r) => {
    hashCheck.value = null
    if (!r) return
    const ok = await verifyRevisionHash(r)
    if (r.id === selectedId.value) hashCheck.value = ok
  },
  { immediate: true },
)

const submitIssues = computed(() => {
  if (!selected.value) return []
  const ws = registry.workstations.map((w) => w.code)
  return validateContent(selected.value.content, ws.length ? { workstations: ws } : {})
})
const submittable = computed(() => canSubmit(submitIssues.value))
const blockingCount = computed(() => submitIssues.value.filter((i) => i.severity !== 'warning').length)

// ---- transitions
type DialogKind = 'submit' | 'approve' | 'reject' | 'newRevision'
const dialog = ref<DialogKind | null>(null)
const comment = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const approvalsKey = ref(0)

function open(kind: DialogKind) {
  dialog.value = kind
  comment.value = ''
  error.value = null
}

const dialogValid = computed(() => {
  if (dialog.value === 'reject' || dialog.value === 'newRevision') return comment.value.trim().length > 0
  return true
})

async function confirm() {
  const r = selected.value
  if (!dialog.value || !dialogValid.value || busy.value) return
  if (!session.online) {
    error.value = t('st.authoring.errors.offline')
    return
  }
  busy.value = true
  error.value = null
  try {
    const c = comment.value.trim()
    switch (dialog.value) {
      case 'submit':
        await procedures.submit(r!.id)
        break
      case 'approve':
        await procedures.approve(r!.id, c || undefined)
        approvalsKey.value++
        break
      case 'reject':
        await procedures.reject(r!.id, c)
        approvalsKey.value++
        break
      case 'newRevision': {
        const created = await procedures.createRevision(props.procedureId, c)
        dialog.value = null
        await router.push({ name: 'st-revision-edit', params: { revisionId: created.id } })
        return
      }
    }
    dialog.value = null
  } catch (e) {
    error.value = errorText(e, t)
  } finally {
    busy.value = false
  }
}

const canNewRevision = computed(() => canCreateRevision(revisions.value, session.user, session.online))
const dialogTitle = computed(() => (dialog.value ? t(`st.authoring.revision.dialog.${dialog.value}Title`, { rev: selected.value?.rev ?? '' }) : ''))
</script>

<template>
  <div class="st-page st-stack">
    <template v-if="procedure">
      <RouterLink :to="{ name: 'st-procedures' }" class="st-proc__back">← {{ t('st.authoring.list.title') }}</RouterLink>
      <div class="st-row">
        <h1 class="st-h1"><span class="st-mono">{{ procedure.number }}</span> {{ procedure.title }}</h1>
        <span class="st-spacer" />
        <button v-if="canNewRevision" type="button" class="st-btn" data-test="new-revision" @click="open('newRevision')">
          + {{ t('st.authoring.revision.new') }}
        </button>
      </div>
      <p v-if="!session.online" class="st-alert st-alert--warn">{{ t('st.authoring.revision.offlineHint') }}</p>

      <div class="st-card st-proc__table-wrap">
        <table class="st-table" data-test="revisions">
          <thead>
            <tr>
              <th>{{ t('st.authoring.revision.rev') }}</th>
              <th>{{ t('st.authoring.revision.status') }}</th>
              <th>{{ t('st.authoring.revision.author') }}</th>
              <th>{{ t('st.authoring.revision.submitted') }}</th>
              <th>{{ t('st.authoring.revision.released') }}</th>
              <th>{{ t('st.authoring.revision.hash') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in newestFirst"
              :key="r.id"
              class="st-proc__row"
              :class="{ 'st-proc__row--on': r.id === selectedId }"
              :data-rev="r.rev"
              tabindex="0"
              @click="select(r)"
              @keydown.enter="select(r)"
            >
              <td class="st-mono st-proc__rev">{{ r.rev }}</td>
              <td><RevisionStatusBadge :status="r.status" /></td>
              <td>{{ registry.userName(r.author_id) }}</td>
              <td>{{ fmtDateTime(r.submitted_at, locale) }}</td>
              <td>{{ fmtDateTime(r.released_at, locale) }}</td>
              <td class="st-mono" :title="r.content_hash ?? undefined">{{ shortHash(r.content_hash) }}</td>
              <td>
                <RouterLink
                  v-if="r.status === 'released'"
                  :to="{ name: 'st-run-new', query: { procedureId: procedure.id } }"
                  class="st-btn st-btn--primary"
                  data-test="start-run"
                  @click.stop
                >
                  {{ t('st.authoring.revision.startRun') }}
                </RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!revisions.length" class="st-muted">{{ t('st.authoring.revision.none') }}</p>
      </div>

      <section v-if="selected && actions" class="st-card st-stack" data-test="revision-detail">
        <div class="st-row">
          <h2 class="st-h2">{{ t('st.authoring.revision.detailTitle', { rev: selected.rev }) }}</h2>
          <RevisionStatusBadge :status="selected.status" />
          <span class="st-spacer" />
          <RouterLink :to="{ name: 'st-revision-edit', params: { revisionId: selected.id } }" class="st-btn" :class="{ 'st-btn--primary': actions.edit }" data-test="edit">
            {{ actions.edit ? t('st.authoring.revision.edit') : t('st.authoring.revision.view') }}
          </RouterLink>
          <button v-if="actions.submit" type="button" class="st-btn st-btn--primary" data-test="submit" @click="open('submit')">
            {{ t('st.authoring.revision.submit') }}
          </button>
          <button v-if="actions.approve" type="button" class="st-btn st-btn--primary" data-test="approve" @click="open('approve')">
            {{ t('st.authoring.revision.approve') }}
          </button>
          <button v-if="actions.reject" type="button" class="st-btn st-btn--danger" data-test="reject" @click="open('reject')">
            {{ t('st.authoring.revision.reject') }}
          </button>
        </div>
        <p v-if="isOwnReview && session.hasRole('approver')" class="st-alert st-alert--info" data-test="own-review">
          {{ t('st.authoring.revision.ownReview') }}
        </p>

        <dl class="st-proc__meta">
          <dt>{{ t('st.authoring.revision.author') }}</dt>
          <dd>{{ registry.userName(selected.author_id) }}</dd>
          <dt>{{ t('st.authoring.revision.created') }}</dt>
          <dd>{{ fmtDateTime(selected.created_at, locale) }}</dd>
          <dt>{{ t('st.authoring.revision.submitted') }}</dt>
          <dd>{{ fmtDateTime(selected.submitted_at, locale) }}</dd>
          <dt>{{ t('st.authoring.revision.released') }}</dt>
          <dd>{{ fmtDateTime(selected.released_at, locale) }}</dd>
          <template v-if="selected.obsoleted_at">
            <dt>{{ t('st.authoring.revision.obsoleted') }}</dt>
            <dd>{{ fmtDateTime(selected.obsoleted_at, locale) }}</dd>
          </template>
          <dt>{{ t('st.authoring.revision.changeReason') }}</dt>
          <dd>{{ selected.change_reason || '—' }}</dd>
          <dt>{{ t('st.authoring.revision.steps') }}</dt>
          <dd>{{ stepCount(selected) }}</dd>
          <dt>{{ t('st.authoring.revision.hash') }}</dt>
          <dd class="st-mono st-proc__hash">
            {{ selected.content_hash ?? t('st.authoring.revision.hashPending') }}
            <span v-if="hashCheck === true" class="st-badge st-badge--ok" data-test="hash-ok">{{ t('st.authoring.revision.hashOk') }}</span>
            <span v-else-if="hashCheck === false" class="st-badge st-badge--danger" data-test="hash-bad">{{ t('st.authoring.revision.hashBad') }}</span>
          </dd>
        </dl>

        <p v-if="actions.submit && !submittable" class="st-alert st-alert--warn" data-test="not-submittable">
          {{ t('st.authoring.revision.notSubmittable', { n: blockingCount }, blockingCount) }}
        </p>

        <RevisionDiff :revision="selected" :baseline="baseline" />
        <ApprovalHistory :revision-id="selected.id" :refresh-key="`${selected.status}-${approvalsKey}`" />
      </section>
    </template>
    <p v-else class="st-alert st-alert--warn">{{ t('st.authoring.list.notFound') }}</p>

    <StDialog :open="!!dialog" :title="dialogTitle" @close="dialog = null">
      <template v-if="dialog === 'submit'">
        <p>{{ t('st.authoring.revision.dialog.submitBody') }}</p>
        <p v-if="!submittable" class="st-alert st-alert--danger">{{ t('st.authoring.revision.notSubmittable', { n: blockingCount }, blockingCount) }}</p>
      </template>
      <p v-else-if="dialog === 'approve'">{{ t('st.authoring.revision.dialog.approveBody') }}</p>
      <p v-else-if="dialog === 'newRevision'">{{ t('st.authoring.revision.dialog.newRevisionBody') }}</p>
      <label v-if="dialog === 'approve' || dialog === 'reject' || dialog === 'newRevision'">
        <span class="st-label">
          {{ dialog === 'newRevision' ? t('st.authoring.revision.changeReason') : t('st.authoring.approvals.comment') }}
          <span class="st-hint">({{ dialog === 'approve' ? t('st.common.optional') : t('st.common.required') }})</span>
        </span>
        <textarea v-model="comment" class="st-textarea" rows="3" data-test="dialog-comment" />
      </label>
      <p v-if="error" class="st-alert st-alert--danger" role="alert" data-test="dialog-error">{{ error }}</p>
      <template #actions>
        <button type="button" class="st-btn" @click="dialog = null">{{ t('st.common.cancel') }}</button>
        <button
          type="button"
          class="st-btn"
          :class="dialog === 'reject' ? 'st-btn--danger' : 'st-btn--primary'"
          :disabled="!dialogValid || busy || (dialog === 'submit' && !submittable)"
          data-test="dialog-confirm"
          @click="confirm"
        >
          {{ dialog ? t(`st.authoring.revision.dialog.${dialog}Confirm`) : '' }}
        </button>
      </template>
    </StDialog>
  </div>
</template>

<style scoped>
.st-proc__back { color: var(--st-primary); text-decoration: none; font-weight: 600; min-height: var(--st-touch); display: inline-flex; align-items: center; }
.st-proc__table-wrap { overflow-x: auto; padding: 0; }
.st-proc__row { cursor: pointer; }
.st-proc__row td { height: 56px; }
.st-proc__row--on { background: var(--st-info-bg); }
.st-proc__rev { font-weight: 700; font-size: 1.1rem; }
.st-proc__meta { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.st-proc__meta dt { color: var(--st-text-muted); font-weight: 600; }
.st-proc__meta dd { margin: 0; }
.st-proc__hash { overflow-wrap: anywhere; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
</style>
