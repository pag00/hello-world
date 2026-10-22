<script setup lang="ts">
// Editor for one input definition. Type-specific fields follow ARCHITECTURE §3.2; limits are edited as
// text and stored as decimal strings (never parsed to Number) so "12.50" is recorded exactly as typed.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Input, InputType, Role } from '../../domain/types'
import { INPUT_TYPES } from './contentOps'
import { ROLES, type Issue } from './validation'
import FieldIssues from './FieldIssues.vue'

const props = defineProps<{ input: Input; issues: Issue[]; readonly?: boolean; first?: boolean; last?: boolean }>()
const emit = defineEmits<{ remove: []; move: [delta: -1 | 1]; changeType: [type: InputType] }>()
const { t } = useI18n()

const fid = (f: string) => `st-in-${props.input.id}-${f}`
const mine = computed(() => props.issues.filter((i) => i.inputId === props.input.id))
const invalid = (f: string) => mine.value.some((i) => i.field === f && i.severity === 'error')

// optional text fields: empty means "not set" (dropped on save by cleanContent)
function optText(key: 'min' | 'nominal' | 'max' | 'expect', v: string) {
  const rec = props.input as unknown as Record<string, unknown>
  rec[key] = v === '' ? null : v
}
function optStr(key: string): string {
  const v = (props.input as unknown as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : ''
}

// integers from <input type=number>: keep whatever was typed visible to validation (1.5 must be flagged,
// not silently truncated); empty → null for optional counts
function intField(key: 'decimals' | 'min_count' | 'max_count', raw: string, optional = false) {
  const rec = props.input as unknown as Record<string, unknown>
  if (raw.trim() === '') rec[key] = optional ? null : Number.NaN
  else rec[key] = Number(raw)
}
function intStr(key: string): string {
  const v = (props.input as unknown as Record<string, unknown>)[key]
  return typeof v === 'number' && !Number.isNaN(v) ? String(v) : ''
}

function onRequired(checked: boolean) {
  props.input.required = checked
  // keep photo counts consistent with "required" so authors are not left with an instant error
  if (props.input.type === 'photo' && checked && props.input.min_count < 1) props.input.min_count = 1
}

function setRole(v: string) {
  if (props.input.type === 'signoff') props.input.role = v ? (v as Role) : null
}
</script>

<template>
  <div class="st-input-ed st-card" :data-input="input.id" :data-type="input.type">
    <div class="st-row st-input-ed__head">
      <label class="st-input-ed__type">
        <span class="st-label">{{ t('st.authoring.input.type') }}</span>
        <select
          class="st-select"
          :value="input.type"
          :disabled="readonly"
          data-test="input-type"
          @change="emit('changeType', ($event.target as HTMLSelectElement).value as InputType)"
        >
          <option v-for="ty in INPUT_TYPES" :key="ty" :value="ty">{{ t(`st.authoring.input.types.${ty}`) }}</option>
        </select>
      </label>
      <label class="st-input-ed__label">
        <span class="st-label">{{ t('st.authoring.input.label') }}</span>
        <input
          :id="fid('label')"
          v-model="input.label"
          class="st-input"
          :readonly="readonly"
          :aria-invalid="invalid('label')"
          data-test="input-label"
        />
        <FieldIssues :issues="mine" field="label" />
      </label>
      <label class="st-row st-input-ed__check">
        <input type="checkbox" class="st-check" :checked="input.required" :disabled="readonly" @change="onRequired(($event.target as HTMLInputElement).checked)" />
        {{ t('st.authoring.input.required') }}
      </label>
      <div v-if="!readonly" class="st-row st-input-ed__tools">
        <button type="button" class="st-btn" :disabled="first" :aria-label="t('st.authoring.editor.moveUp')" @click="emit('move', -1)">↑</button>
        <button type="button" class="st-btn" :disabled="last" :aria-label="t('st.authoring.editor.moveDown')" @click="emit('move', 1)">↓</button>
        <button type="button" class="st-btn st-btn--ghost" data-test="input-remove" @click="emit('remove')">{{ t('st.authoring.input.remove') }}</button>
      </div>
    </div>

    <div v-if="input.type === 'text'" class="st-row">
      <label class="st-row st-input-ed__check">
        <input v-model="input.multiline" type="checkbox" class="st-check" :disabled="readonly" />
        {{ t('st.authoring.input.multiline') }}
      </label>
    </div>

    <div v-else-if="input.type === 'number'" class="st-input-ed__grid">
      <label>
        <span class="st-label">{{ t('st.authoring.input.unit') }}</span>
        <input v-model="input.unit" class="st-input" :readonly="readonly" data-test="num-unit" />
      </label>
      <label>
        <span class="st-label">{{ t('st.authoring.input.decimals') }}</span>
        <input
          class="st-input"
          type="number"
          inputmode="numeric"
          min="0"
          step="1"
          :value="intStr('decimals')"
          :readonly="readonly"
          :aria-invalid="invalid('decimals')"
          data-test="num-decimals"
          @input="intField('decimals', ($event.target as HTMLInputElement).value)"
        />
        <FieldIssues :issues="mine" field="decimals" />
      </label>
      <label v-for="f in (['min', 'nominal', 'max'] as const)" :key="f">
        <span class="st-label">{{ t(`st.authoring.input.${f}`) }}</span>
        <input
          class="st-input st-mono"
          inputmode="decimal"
          :value="optStr(f)"
          :readonly="readonly"
          :placeholder="t('st.authoring.input.unbounded')"
          :aria-invalid="invalid(f)"
          :data-test="`num-${f}`"
          @input="optText(f, ($event.target as HTMLInputElement).value)"
        />
        <FieldIssues :issues="mine" :field="f" />
      </label>
      <label class="st-row st-input-ed__check">
        <input v-model="input.ocr" type="checkbox" class="st-check" :disabled="readonly" />
        {{ t('st.authoring.input.ocr') }}
      </label>
    </div>

    <div v-else-if="input.type === 'photo'" class="st-input-ed__grid">
      <label>
        <span class="st-label">{{ t('st.authoring.input.minCount') }}</span>
        <input
          class="st-input"
          type="number"
          inputmode="numeric"
          min="0"
          step="1"
          :value="intStr('min_count')"
          :readonly="readonly"
          :aria-invalid="invalid('min_count')"
          data-test="photo-min"
          @input="intField('min_count', ($event.target as HTMLInputElement).value)"
        />
        <FieldIssues :issues="mine" field="min_count" />
      </label>
      <label>
        <span class="st-label">{{ t('st.authoring.input.maxCount') }}</span>
        <input
          class="st-input"
          type="number"
          inputmode="numeric"
          min="1"
          step="1"
          :value="intStr('max_count')"
          :readonly="readonly"
          :placeholder="t('st.authoring.input.unlimited')"
          :aria-invalid="invalid('max_count')"
          data-test="photo-max"
          @input="intField('max_count', ($event.target as HTMLInputElement).value, true)"
        />
        <FieldIssues :issues="mine" field="max_count" />
      </label>
    </div>

    <div v-else-if="input.type === 'scan'" class="st-input-ed__grid">
      <label>
        <span class="st-label">{{ t('st.authoring.input.entity') }}</span>
        <select v-model="input.entity" class="st-select" :disabled="readonly">
          <option v-for="e in (['part', 'tool', 'any'] as const)" :key="e" :value="e">{{ t(`st.authoring.input.entities.${e}`) }}</option>
        </select>
      </label>
      <label class="st-input-ed__wide">
        <span class="st-label">{{ t('st.authoring.input.expect') }}</span>
        <input
          class="st-input st-mono"
          :value="optStr('expect')"
          :readonly="readonly"
          :placeholder="t('st.authoring.input.expectPlaceholder')"
          :aria-invalid="invalid('expect')"
          data-test="scan-expect"
          @input="optText('expect', ($event.target as HTMLInputElement).value)"
        />
        <span class="st-hint">{{ t('st.authoring.input.expectHint') }}</span>
        <FieldIssues :issues="mine" field="expect" />
      </label>
    </div>

    <div v-else-if="input.type === 'signoff'" class="st-input-ed__grid">
      <label>
        <span class="st-label">{{ t('st.authoring.input.signoffRole') }}</span>
        <select class="st-select" :value="input.role ?? ''" :disabled="readonly" @change="setRole(($event.target as HTMLSelectElement).value)">
          <option value="">{{ t('st.authoring.input.anyRole') }}</option>
          <option v-for="r in ROLES" :key="r" :value="r">{{ t(`st.authoring.roles.${r}`) }}</option>
        </select>
        <FieldIssues :issues="mine" field="role" />
      </label>
    </div>

    <FieldIssues :issues="mine.filter((i) => !i.field || i.field === 'id')" />
  </div>
</template>

<style scoped>
.st-input-ed { display: flex; flex-direction: column; gap: 10px; padding: 12px; box-shadow: none; background: var(--st-surface-2); }
.st-input-ed__head { align-items: flex-start; }
.st-input-ed__type { width: 170px; }
.st-input-ed__label { flex: 1; min-width: 200px; }
.st-input-ed__check { min-height: var(--st-touch); gap: 8px; font-weight: 600; cursor: pointer; }
.st-input-ed__tools { gap: 6px; align-self: flex-end; }
.st-input-ed__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; align-items: start; }
.st-input-ed__wide { grid-column: span 2; }
.st-check { width: 26px; height: 26px; }
[aria-invalid='true'] { border-color: var(--st-danger); }
</style>
