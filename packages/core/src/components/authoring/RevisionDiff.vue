<script setup lang="ts">
// Step-level changes of a revision against its baseline (the previously released revision).
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProcedureRevision } from '../../domain/types'
import { diffRevisions, isEmptyDiff } from './diff'

const props = defineProps<{ revision: ProcedureRevision; baseline: ProcedureRevision | null }>()
const { t } = useI18n()

const diff = computed(() => diffRevisions(props.baseline?.content ?? null, props.revision.content))
const empty = computed(() => isEmptyDiff(diff.value))
const fieldLabel = (f: string) => t(`st.authoring.diff.fields.${f}`)
</script>

<template>
  <section class="st-diff st-stack" data-test="revision-diff">
    <h3 class="st-h2">
      {{ baseline ? t('st.authoring.diff.titleVs', { rev: revision.rev, base: baseline.rev }) : t('st.authoring.diff.titleFirst', { rev: revision.rev }) }}
    </h3>
    <div class="st-row">
      <span class="st-badge st-badge--ok" data-test="diff-added">{{ t('st.authoring.diff.added', { n: diff.added.length }) }}</span>
      <span class="st-badge st-badge--danger" data-test="diff-removed">{{ t('st.authoring.diff.removed', { n: diff.removed.length }) }}</span>
      <span class="st-badge st-badge--warn" data-test="diff-changed">{{ t('st.authoring.diff.changed', { n: diff.changed.length }) }}</span>
      <span class="st-badge">{{ t('st.authoring.diff.unchanged', { n: diff.unchanged }) }}</span>
    </div>
    <p v-if="empty && baseline" class="st-alert st-alert--warn">{{ t('st.authoring.diff.noChanges') }}</p>

    <ul class="st-diff__list">
      <li v-for="s in diff.added" :key="s.step_id" class="st-diff__item st-diff__item--added" data-kind="added">
        <span class="st-badge st-badge--ok">{{ t('st.authoring.diff.kind.added') }}</span>
        <span class="st-muted">{{ s.section_title }} ›</span> <strong>{{ s.title }}</strong>
      </li>
      <li v-for="s in diff.removed" :key="s.step_id" class="st-diff__item st-diff__item--removed" data-kind="removed">
        <span class="st-badge st-badge--danger">{{ t('st.authoring.diff.kind.removed') }}</span>
        <span class="st-muted">{{ s.section_title }} ›</span> <del>{{ s.title }}</del>
      </li>
      <li v-for="c in diff.changed" :key="c.step_id" class="st-diff__item st-diff__item--changed" data-kind="changed" :data-step="c.step_id">
        <div>
          <span class="st-badge st-badge--warn">{{ t('st.authoring.diff.kind.changed') }}</span>
          <span class="st-muted">{{ c.section_title }} ›</span> <strong>{{ c.title }}</strong>
        </div>
        <div class="st-diff__fields">
          <span v-for="f in c.fields" :key="f" class="st-badge st-badge--info" :data-field="f">{{ fieldLabel(f) }}</span>
        </div>
        <p v-if="c.fields.includes('title')" class="st-diff__change">
          <del>{{ c.before.title }}</del> → <ins>{{ c.after.title }}</ins>
        </p>
        <ul v-if="c.inputs.length" class="st-diff__inputs">
          <li v-for="i in c.inputs" :key="i.input_id" :data-input="i.input_id">
            <span class="st-badge" :class="{ 'st-badge--ok': i.kind === 'added', 'st-badge--danger': i.kind === 'removed', 'st-badge--warn': i.kind === 'changed' }">
              {{ t(`st.authoring.diff.kind.${i.kind}`) }}
            </span>
            {{ i.label || t('st.authoring.diff.unnamedInput') }}
            <span v-if="i.fields.length" class="st-muted">({{ i.fields.map((f) => t(`st.authoring.diff.inputFields.${f}`)).join(', ') }})</span>
          </li>
        </ul>
      </li>
      <li v-for="r in diff.renamed_sections" :key="r.section_id" class="st-diff__item" data-kind="section">
        <span class="st-badge st-badge--info">{{ t('st.authoring.diff.sectionRenamed') }}</span>
        <del>{{ r.before }}</del> → <ins>{{ r.after }}</ins>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.st-diff__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.st-diff__item { padding: 10px 12px; border-radius: var(--st-radius); border: 1px solid var(--st-border); border-left-width: 6px; }
.st-diff__item--added { border-left-color: var(--st-ok); }
.st-diff__item--removed { border-left-color: var(--st-danger); }
.st-diff__item--changed { border-left-color: var(--st-warn); }
.st-diff__fields { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.st-diff__change { margin: 6px 0 0; }
.st-diff__inputs { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
ins { text-decoration: none; background: var(--st-ok-bg); }
del { background: var(--st-danger-bg); }
</style>
