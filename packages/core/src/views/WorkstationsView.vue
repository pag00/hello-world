<script setup lang="ts">
// Workstation registry (admin edits, online only) and printable QR labels. A workstation's code is its
// identity — it is what step locations reference and what the printed QR encodes — so it is not editable.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Workstation } from '../domain/types'
import { useStepTrackConfig } from '../config'
import { useRegistryStore, useSessionStore } from '../stores'
import StDialog from '../components/StDialog.vue'
import LabelSheet from '../components/quality/LabelSheet.vue'
import { labelUrl, type Label } from '../components/quality/labels'
import { errorText } from '../components/authoring/errors'

const { t } = useI18n()
const cfg = useStepTrackConfig()
const registry = useRegistryStore()
const session = useSessionStore()

const isAdmin = computed(() => session.hasRole('admin'))
const query = ref('')
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return registry.workstations.filter((w) => !q || w.code.toLowerCase().includes(q) || w.name.toLowerCase().includes(q))
})

// ---- edit
const editing = ref<{ ws: Workstation; isNew: boolean } | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

function openEdit(ws?: Workstation) {
  error.value = null
  editing.value = { ws: ws ? { ...ws } : { code: '', name: '' }, isNew: !ws }
}

// codes travel in URLs and st:ws:<code> payloads; keep them to a scanner-friendly alphabet
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const codeInvalid = computed(() => !!editing.value?.isNew && !!editing.value.ws.code.trim() && !CODE_RE.test(editing.value.ws.code.trim()))
const codeTaken = computed(() => {
  const e = editing.value
  if (!e?.isNew) return false
  const c = e.ws.code.trim().toLowerCase()
  return registry.workstations.some((w) => w.code.toLowerCase() === c)
})
const editValid = computed(() => {
  const e = editing.value
  return !!e && !!e.ws.code.trim() && !!e.ws.name.trim() && !codeInvalid.value && !codeTaken.value
})

async function save() {
  const e = editing.value
  if (!e || !editValid.value || busy.value) return
  if (!session.online) {
    error.value = t('st.authoring.errors.offline')
    return
  }
  busy.value = true
  error.value = null
  try {
    await registry.upsertWorkstation({ code: e.ws.code.trim(), name: e.ws.name.trim() })
    editing.value = null
  } catch (err) {
    error.value = errorText(err, t)
  } finally {
    busy.value = false
  }
}

// ---- labels
const selected = ref<Set<string>>(new Set())
const allShownSelected = computed(() => shown.value.length > 0 && shown.value.every((w) => selected.value.has(w.code)))
function toggle(code: string) {
  const s = new Set(selected.value)
  if (s.has(code)) s.delete(code)
  else s.add(code)
  selected.value = s
}
function toggleAll() {
  selected.value = allShownSelected.value ? new Set() : new Set(shown.value.map((w) => w.code))
}
const labels = computed<Label[]>(() =>
  registry.workstations
    .filter((w) => selected.value.has(w.code))
    .map((w) => ({ key: w.code, url: labelUrl('ws', w.code, cfg), title: w.code, subtitle: w.name })),
)
function printLabels() {
  if (labels.value.length) window.print()
}
</script>

<template>
  <div class="st-page st-stack">
    <div class="st-row st-noprint">
      <h1 class="st-h1">{{ t('st.quality.workstations.title') }}</h1>
      <span class="st-spacer" />
      <button type="button" class="st-btn" :disabled="!labels.length" data-test="print-labels" @click="printLabels">
        {{ t('st.quality.labels.print', { n: labels.length }, labels.length) }}
      </button>
      <button
        v-if="isAdmin"
        type="button"
        class="st-btn st-btn--primary"
        :disabled="!session.online"
        :title="session.online ? undefined : t('st.common.onlineOnly')"
        data-test="add-ws"
        @click="openEdit()"
      >
        + {{ t('st.quality.workstations.add') }}
      </button>
    </div>

    <div class="st-stack st-noprint">
      <input v-model="query" class="st-input" type="search" :placeholder="t('st.quality.workstations.search')" :aria-label="t('st.common.search')" />
      <p v-if="!registry.workstations.length" class="st-muted">{{ t('st.quality.workstations.empty') }}</p>
      <div v-else class="st-card st-ws__wrap">
        <table class="st-table" data-test="workstations">
          <thead>
            <tr>
              <th>
                <input type="checkbox" class="st-ws__check" :checked="allShownSelected" :aria-label="t('st.quality.labels.selectAll')" @change="toggleAll" />
              </th>
              <th>{{ t('st.quality.workstations.code') }}</th>
              <th>{{ t('st.quality.workstations.name') }}</th>
              <th v-if="isAdmin" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in shown" :key="w.code" :data-ws="w.code">
              <td>
                <input type="checkbox" class="st-ws__check" :checked="selected.has(w.code)" :aria-label="t('st.quality.labels.select', { code: w.code })" @change="toggle(w.code)" />
              </td>
              <td class="st-mono st-ws__code">{{ w.code }}</td>
              <td>{{ w.name }}</td>
              <td v-if="isAdmin">
                <button type="button" class="st-btn" :disabled="!session.online" data-test="edit-ws" @click="openEdit(w)">{{ t('st.common.edit') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!shown.length" class="st-muted">{{ t('st.quality.workstations.noMatch') }}</p>
      </div>
    </div>

    <section v-if="labels.length" class="st-stack">
      <h2 class="st-h2 st-noprint">{{ t('st.quality.labels.preview') }}</h2>
      <LabelSheet :labels="labels" />
    </section>

    <StDialog :open="!!editing" :title="editing?.isNew ? t('st.quality.workstations.addTitle') : t('st.quality.workstations.editTitle')" @close="editing = null">
      <form v-if="editing" class="st-stack" @submit.prevent="save">
        <label>
          <span class="st-label">{{ t('st.quality.workstations.code') }}</span>
          <input v-model="editing.ws.code" class="st-input st-mono" :readonly="!editing.isNew" required autocomplete="off" data-test="ws-code" />
          <span v-if="!editing.isNew" class="st-hint">{{ t('st.quality.workstations.codeFixed') }}</span>
          <span v-if="codeInvalid" class="st-hint st-ws__err">{{ t('st.quality.workstations.codeInvalid') }}</span>
          <span v-if="codeTaken" class="st-hint st-ws__err">{{ t('st.quality.workstations.codeTaken') }}</span>
        </label>
        <label>
          <span class="st-label">{{ t('st.quality.workstations.name') }}</span>
          <input v-model="editing.ws.name" class="st-input" required autocomplete="off" data-test="ws-name" />
        </label>
        <p v-if="error" class="st-alert st-alert--danger" role="alert">{{ error }}</p>
        <button type="submit" hidden />
      </form>
      <template #actions>
        <button type="button" class="st-btn" @click="editing = null">{{ t('st.common.cancel') }}</button>
        <button type="button" class="st-btn st-btn--primary" :disabled="!editValid || busy" data-test="ws-save" @click="save">{{ t('st.common.save') }}</button>
      </template>
    </StDialog>
  </div>
</template>

<style scoped>
.st-ws__wrap { overflow-x: auto; padding: 0; }
.st-ws__check { width: 26px; height: 26px; }
.st-ws__code { font-weight: 700; }
.st-ws__err { color: var(--st-danger); }
</style>
