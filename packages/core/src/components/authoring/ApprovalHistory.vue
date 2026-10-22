<script setup lang="ts">
// Review decisions on a revision (who approved/rejected, when, with what comment). Online only:
// approvals are server records and are not part of the offline pull.
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Approval } from '../../domain/types'
import { useProceduresStore, useRegistryStore, useSessionStore } from '../../stores'
import { fmtDateTime } from '../run/format'
import { errorText } from './errors'

const props = defineProps<{ revisionId: string; refreshKey?: unknown }>()
const { t, locale } = useI18n()
const procedures = useProceduresStore()
const registry = useRegistryStore()
const session = useSessionStore()

const approvals = ref<Approval[] | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)

async function load() {
  approvals.value = null
  error.value = null
  if (!session.online) return
  loading.value = true
  const id = props.revisionId
  try {
    const list = await procedures.approvalsOf(id)
    if (id === props.revisionId) approvals.value = [...list].sort((a, b) => (a.signed_at < b.signed_at ? -1 : 1))
  } catch (e) {
    if (id === props.revisionId) error.value = errorText(e, t)
  } finally {
    loading.value = false
  }
}

watch(() => [props.revisionId, props.refreshKey, session.online], load, { immediate: true })
</script>

<template>
  <section class="st-stack" data-test="approvals">
    <h3 class="st-h2">{{ t('st.authoring.approvals.title') }}</h3>
    <p v-if="!session.online" class="st-muted">{{ t('st.authoring.approvals.offline') }}</p>
    <p v-else-if="loading" class="st-muted">{{ t('st.common.loading') }}</p>
    <p v-else-if="error" class="st-alert st-alert--danger">{{ error }}</p>
    <p v-else-if="approvals && !approvals.length" class="st-muted">{{ t('st.authoring.approvals.none') }}</p>
    <table v-else-if="approvals" class="st-table">
      <thead>
        <tr>
          <th>{{ t('st.authoring.approvals.decision') }}</th>
          <th>{{ t('st.authoring.approvals.by') }}</th>
          <th>{{ t('st.authoring.approvals.at') }}</th>
          <th>{{ t('st.authoring.approvals.comment') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="a in approvals" :key="a.id" :data-decision="a.decision">
          <td>
            <span class="st-badge" :class="a.decision === 'approve' ? 'st-badge--ok' : 'st-badge--danger'">{{ t(`st.authoring.approvals.${a.decision}`) }}</span>
          </td>
          <td>{{ registry.userName(a.approver_id) }}</td>
          <td>{{ fmtDateTime(a.signed_at, locale) }}</td>
          <td>{{ a.comment || '—' }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
