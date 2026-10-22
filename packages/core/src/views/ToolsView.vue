<script setup lang="ts">
// Tool registry with calibration status (admin edits, online only) and printable QR labels.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Tool } from '../domain/types'
import { useStepTrackConfig } from '../config'
import { useRegistryStore, useSessionStore } from '../stores'
import StDialog from '../components/StDialog.vue'
import CalibrationBadge from '../components/quality/CalibrationBadge.vue'
import LabelSheet from '../components/quality/LabelSheet.vue'
import { calibrationStatus, isValidDate, type CalibrationStatus } from '../components/quality/calibration'
import { labelUrl, type Label } from '../components/quality/labels'
import { errorText } from '../components/authoring/errors'

type Filter = 'all' | CalibrationStatus | 'inactive'
const FILTERS: Filter[] = ['all', 'expired', 'due_soon', 'ok', 'not_required', 'inactive']

const { t } = useI18n()
const cfg = useStepTrackConfig()
const registry = useRegistryStore()
const session = useSessionStore()

const isAdmin = computed(() => session.hasRole('admin'))
const query = ref('')
const filter = ref<Filter>('all')

function matches(tool: Tool, f: Filter): boolean {
  if (f === 'all') return true
  if (f === 'inactive') return !tool.active
  return tool.active && calibrationStatus(tool).status === f
}
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return registry.tools.filter((x) => matches(x, filter.value) && (!q || x.code.toLowerCase().includes(q) || x.description.toLowerCase().includes(q)))
})
const count = (f: Filter) => registry.tools.filter((x) => matches(x, f)).length

// ---- edit
const editing = ref<(Omit<Tool, 'id'> & { id?: string }) | null>(null)
const noCalibration = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)

function openEdit(tool?: Tool) {
  error.value = null
  editing.value = tool ? { ...tool } : { code: '', description: '', calibration_due: '', active: true }
  noCalibration.value = !!tool && !tool.calibration_due
}

const codeTaken = computed(() => {
  const e = editing.value
  if (!e) return false
  const c = e.code.trim().toLowerCase()
  return registry.tools.some((x) => x.id !== e.id && x.code.toLowerCase() === c)
})
const dueInvalid = computed(() => !!editing.value && !noCalibration.value && !isValidDate(editing.value.calibration_due ?? ''))
const editValid = computed(() => !!editing.value && !!editing.value.code.trim() && !codeTaken.value && !dueInvalid.value)

async function saveTool() {
  const e = editing.value
  if (!e || !editValid.value || busy.value) return
  if (!session.online) {
    error.value = t('st.authoring.errors.offline')
    return
  }
  busy.value = true
  error.value = null
  try {
    await registry.upsertTool({
      ...(e.id ? { id: e.id } : {}),
      code: e.code.trim(),
      description: e.description.trim(),
      calibration_due: noCalibration.value ? null : e.calibration_due,
      active: e.active,
    })
    editing.value = null
  } catch (err) {
    error.value = errorText(err, t)
  } finally {
    busy.value = false
  }
}

// ---- labels
const selected = ref<Set<string>>(new Set())
const allShownSelected = computed(() => shown.value.length > 0 && shown.value.every((x) => selected.value.has(x.id)))
function toggle(id: string) {
  const s = new Set(selected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selected.value = s
}
function toggleAll() {
  selected.value = allShownSelected.value ? new Set() : new Set(shown.value.map((x) => x.id))
}
const labels = computed<Label[]>(() =>
  registry.tools
    .filter((x) => selected.value.has(x.id))
    .map((x) => ({ key: x.id, url: labelUrl('tool', x.code, cfg), title: x.code, subtitle: x.description })),
)
function printLabels() {
  if (labels.value.length) window.print()
}
</script>

<template>
  <div class="st-page st-stack">
    <div class="st-row st-noprint">
      <h1 class="st-h1">{{ t('st.quality.tools.title') }}</h1>
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
        data-test="add-tool"
        @click="openEdit()"
      >
        + {{ t('st.quality.tools.add') }}
      </button>
    </div>

    <div class="st-stack st-noprint">
      <input v-model="query" class="st-input" type="search" :placeholder="t('st.quality.tools.search')" :aria-label="t('st.common.search')" />
      <div class="st-row">
        <button
          v-for="f in FILTERS"
          :key="f"
          type="button"
          class="st-btn"
          :class="{ 'st-btn--primary': filter === f }"
          :aria-pressed="filter === f"
          :data-filter="f"
          @click="filter = f"
        >
          {{ t(`st.quality.tools.filter.${f}`) }} <span class="st-badge">{{ count(f) }}</span>
        </button>
      </div>
      <p v-if="!registry.tools.length" class="st-muted">{{ t('st.quality.tools.empty') }}</p>
      <div v-else class="st-card st-tools__wrap">
        <table class="st-table" data-test="tools">
          <thead>
            <tr>
              <th>
                <input type="checkbox" class="st-tools__check" :checked="allShownSelected" :aria-label="t('st.quality.labels.selectAll')" @change="toggleAll" />
              </th>
              <th>{{ t('st.quality.tools.code') }}</th>
              <th>{{ t('st.quality.tools.description') }}</th>
              <th>{{ t('st.quality.tools.calibrationDue') }}</th>
              <th>{{ t('st.quality.tools.status') }}</th>
              <th v-if="isAdmin" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="tool in shown" :key="tool.id" :data-tool="tool.code" :class="{ 'st-tools__inactive': !tool.active }">
              <td>
                <input
                  type="checkbox"
                  class="st-tools__check"
                  :checked="selected.has(tool.id)"
                  :aria-label="t('st.quality.labels.select', { code: tool.code })"
                  @change="toggle(tool.id)"
                />
              </td>
              <td class="st-mono st-tools__code">{{ tool.code }}</td>
              <td>{{ tool.description }}</td>
              <td class="st-mono">{{ tool.calibration_due ?? '—' }}</td>
              <td>
                <span v-if="!tool.active" class="st-badge" data-status="inactive">{{ t('st.quality.tools.inactive') }}</span>
                <CalibrationBadge v-else :tool="tool" />
              </td>
              <td v-if="isAdmin">
                <button type="button" class="st-btn" :disabled="!session.online" data-test="edit-tool" @click="openEdit(tool)">{{ t('st.common.edit') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!shown.length" class="st-muted">{{ t('st.quality.tools.noMatch') }}</p>
      </div>
    </div>

    <section v-if="labels.length" class="st-stack st-tools__labels">
      <h2 class="st-h2 st-noprint">{{ t('st.quality.labels.preview') }}</h2>
      <LabelSheet :labels="labels" />
    </section>

    <StDialog :open="!!editing" :title="editing?.id ? t('st.quality.tools.editTitle') : t('st.quality.tools.addTitle')" @close="editing = null">
      <form v-if="editing" class="st-stack" @submit.prevent="saveTool">
        <label>
          <span class="st-label">{{ t('st.quality.tools.code') }}</span>
          <input v-model="editing.code" class="st-input st-mono" required autocomplete="off" data-test="tool-code" />
          <span v-if="codeTaken" class="st-hint st-tools__err">{{ t('st.quality.tools.codeTaken') }}</span>
        </label>
        <label>
          <span class="st-label">{{ t('st.quality.tools.description') }}</span>
          <input v-model="editing.description" class="st-input" autocomplete="off" data-test="tool-desc" />
        </label>
        <label class="st-row st-tools__toggle">
          <input v-model="noCalibration" type="checkbox" class="st-tools__check" data-test="tool-no-cal" />
          {{ t('st.quality.tools.noCalibration') }}
        </label>
        <label v-if="!noCalibration">
          <span class="st-label">{{ t('st.quality.tools.calibrationDue') }}</span>
          <input v-model="editing.calibration_due" type="date" class="st-input" required data-test="tool-due" />
          <span v-if="dueInvalid" class="st-hint st-tools__err">{{ t('st.quality.tools.dueRequired') }}</span>
        </label>
        <label class="st-row st-tools__toggle">
          <input v-model="editing.active" type="checkbox" class="st-tools__check" data-test="tool-active" />
          {{ t('st.quality.tools.active') }}
        </label>
        <p v-if="error" class="st-alert st-alert--danger" role="alert">{{ error }}</p>
        <button type="submit" hidden />
      </form>
      <template #actions>
        <button type="button" class="st-btn" @click="editing = null">{{ t('st.common.cancel') }}</button>
        <button type="button" class="st-btn st-btn--primary" :disabled="!editValid || busy" data-test="tool-save" @click="saveTool">{{ t('st.common.save') }}</button>
      </template>
    </StDialog>
  </div>
</template>

<style scoped>
.st-tools__wrap { overflow-x: auto; padding: 0; }
.st-tools__check { width: 26px; height: 26px; }
.st-tools__code { font-weight: 700; }
.st-tools__inactive td { color: var(--st-text-muted); }
.st-tools__toggle { min-height: var(--st-touch); font-weight: 600; cursor: pointer; }
.st-tools__err { color: var(--st-danger); }
</style>
