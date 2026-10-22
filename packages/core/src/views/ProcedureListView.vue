<script setup lang="ts">
// Procedure catalogue: search, current released revision, open draft/review, create (authors, online).
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { Procedure } from '../domain/types'
import { useProceduresStore, useSessionStore } from '../stores'
import StDialog from '../components/StDialog.vue'
import RevisionStatusBadge from '../components/authoring/RevisionStatusBadge.vue'
import { openRevision } from '../components/authoring/revisions'
import { errorText } from '../components/authoring/errors'

const { t } = useI18n()
const router = useRouter()
const procedures = useProceduresStore()
const session = useSessionStore()

const query = ref('')
const rows = computed(() => {
  const q = query.value.trim().toLowerCase()
  return procedures.procedures
    .filter((p) => !q || p.number.toLowerCase().includes(q) || p.title.toLowerCase().includes(q))
    .map((p) => {
      const revs = procedures.revisionsOf(p.id)
      return { procedure: p, released: procedures.releasedRevision(p.id), open: openRevision(revs) }
    })
})

const canCreate = computed(() => session.hasRole('author'))

// ---- create
const dialog = ref(false)
const number = ref('')
const title = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const numberTaken = computed(() => {
  const n = number.value.trim().toLowerCase()
  return !!n && procedures.procedures.some((p: Procedure) => p.number.toLowerCase() === n)
})
const valid = computed(() => !!number.value.trim() && !!title.value.trim() && !numberTaken.value)

function openCreate() {
  number.value = ''
  title.value = ''
  error.value = null
  dialog.value = true
}

async function create() {
  if (!valid.value || busy.value) return
  if (!session.online) {
    error.value = t('st.authoring.errors.offline')
    return
  }
  busy.value = true
  error.value = null
  try {
    const { revision } = await procedures.createProcedure({ number: number.value, title: title.value })
    dialog.value = false
    await router.push({ name: 'st-revision-edit', params: { revisionId: revision.id } })
  } catch (e) {
    error.value = errorText(e, t)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="st-page st-stack">
    <div class="st-row">
      <h1 class="st-h1">{{ t('st.authoring.list.title') }}</h1>
      <span class="st-spacer" />
      <button
        v-if="canCreate"
        type="button"
        class="st-btn st-btn--primary"
        :disabled="!session.online"
        :title="session.online ? undefined : t('st.common.onlineOnly')"
        data-test="create-procedure"
        @click="openCreate"
      >
        + {{ t('st.authoring.list.create') }}
      </button>
    </div>
    <input
      v-model="query"
      class="st-input"
      type="search"
      :placeholder="t('st.authoring.list.search')"
      :aria-label="t('st.common.search')"
      data-test="search"
    />

    <p v-if="!procedures.procedures.length" class="st-muted">{{ t('st.authoring.list.empty') }}</p>
    <p v-else-if="!rows.length" class="st-muted">{{ t('st.authoring.list.noMatch') }}</p>

    <ul class="st-proc-list">
      <li v-for="r in rows" :key="r.procedure.id">
        <RouterLink :to="{ name: 'st-procedure', params: { procedureId: r.procedure.id } }" class="st-card st-proc-list__item" data-test="procedure-row">
          <span class="st-mono st-proc-list__num">{{ r.procedure.number }}</span>
          <span class="st-proc-list__title">{{ r.procedure.title }}</span>
          <span class="st-row st-proc-list__badges">
            <span v-if="r.released" class="st-badge st-badge--ok">{{ t('st.authoring.list.releasedRev', { rev: r.released.rev }) }}</span>
            <span v-else class="st-badge">{{ t('st.authoring.list.notReleased') }}</span>
            <template v-if="r.open">
              <span class="st-mono">{{ r.open.rev }}</span>
              <RevisionStatusBadge :status="r.open.status" />
            </template>
          </span>
        </RouterLink>
      </li>
    </ul>

    <StDialog :open="dialog" :title="t('st.authoring.list.createTitle')" @close="dialog = false">
      <form class="st-stack" @submit.prevent="create">
        <label>
          <span class="st-label">{{ t('st.authoring.list.number') }}</span>
          <input v-model="number" class="st-input st-mono" required autocomplete="off" :placeholder="t('st.authoring.list.numberPlaceholder')" data-test="new-number" />
          <span v-if="numberTaken" class="st-hint st-danger-text">{{ t('st.authoring.list.numberTaken') }}</span>
        </label>
        <label>
          <span class="st-label">{{ t('st.authoring.list.procTitle') }}</span>
          <input v-model="title" class="st-input" required autocomplete="off" data-test="new-title" />
        </label>
        <p class="st-hint">{{ t('st.authoring.list.createHint') }}</p>
        <p v-if="error" class="st-alert st-alert--danger" role="alert">{{ error }}</p>
        <button type="submit" hidden />
      </form>
      <template #actions>
        <button type="button" class="st-btn" @click="dialog = false">{{ t('st.common.cancel') }}</button>
        <button type="button" class="st-btn st-btn--primary" :disabled="!valid || busy" data-test="create-confirm" @click="create">
          {{ t('st.authoring.list.createConfirm') }}
        </button>
      </template>
    </StDialog>
  </div>
</template>

<style scoped>
.st-proc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.st-proc-list__item {
  display: flex; align-items: center; gap: var(--st-gap); flex-wrap: wrap; min-height: 64px;
  color: inherit; text-decoration: none;
}
.st-proc-list__num { font-weight: 700; min-width: 7em; }
.st-proc-list__title { flex: 1; min-width: 12em; font-weight: 600; }
.st-proc-list__badges { gap: 8px; }
.st-danger-text { color: var(--st-danger); }
</style>
