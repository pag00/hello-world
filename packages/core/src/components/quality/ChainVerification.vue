<script setup lang="ts">
// Integrity of the as-run record, shown prominently: the server's verdict (GET /runs/{id}/verify, which
// recomputes every content hash and the chain) plus a local recomputation of the cached ledger.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RunEvent } from '../../domain/types'
import { api, type RunVerifyResult } from '../../api/endpoints'
import { useSessionStore } from '../../stores'
import { verifyLedger, type LedgerCheck } from './recordVerify'
import { errorText } from '../authoring/errors'

const props = defineProps<{ runId: string; events: readonly RunEvent[] }>()
const { t } = useI18n()
const session = useSessionStore()

const server = ref<RunVerifyResult | null>(null)
const serverState = ref<'idle' | 'loading' | 'done' | 'error'>('idle')
const serverError = ref<string | null>(null)
const local = ref<LedgerCheck | null>(null)

async function runServer() {
  if (!session.online) return
  serverState.value = 'loading'
  serverError.value = null
  try {
    server.value = await api.verifyRun(props.runId)
    serverState.value = 'done'
  } catch (e) {
    server.value = null
    serverError.value = errorText(e, t)
    serverState.value = 'error'
  }
}

watch(() => [props.runId, session.online], () => void runServer(), { immediate: true })

let token = 0
watch(
  () => props.events,
  async (evs) => {
    const mine = ++token
    const r = await verifyLedger(evs)
    if (mine === token) local.value = r
  },
  { immediate: true },
)

const tone = computed(() => {
  if (serverState.value === 'done' && server.value) return server.value.ok && local.value?.ok !== false ? 'ok' : 'danger'
  if (local.value && !local.value.ok) return 'danger'
  return 'warn'
})
</script>

<template>
  <section class="st-chain st-alert" :class="`st-alert--${tone}`" data-test="chain" :data-tone="tone">
    <div class="st-chain__main">
      <template v-if="serverState === 'done' && server">
        <strong v-if="server.ok" class="st-chain__verdict" data-test="chain-ok">✔ {{ t('st.quality.chain.serverOk', { n: server.event_count }) }}</strong>
        <template v-else>
          <strong class="st-chain__verdict" data-test="chain-bad">✖ {{ t('st.quality.chain.serverBad') }}</strong>
          <span v-if="server.first_bad_event_id" class="st-mono">{{ t('st.quality.chain.firstBad', { id: server.first_bad_event_id }) }}</span>
          <ul v-if="server.errors?.length" class="st-chain__errors">
            <li v-for="(e, i) in server.errors" :key="i">{{ e }}</li>
          </ul>
        </template>
      </template>
      <strong v-else-if="serverState === 'loading'" class="st-chain__verdict">{{ t('st.quality.chain.checking') }}</strong>
      <strong v-else-if="!session.online" class="st-chain__verdict" data-test="chain-offline">{{ t('st.quality.chain.offline') }}</strong>
      <strong v-else-if="serverState === 'error'" class="st-chain__verdict">{{ t('st.quality.chain.serverError') }} {{ serverError }}</strong>
    </div>

    <div v-if="local" class="st-chain__local" data-test="chain-local">
      <span v-if="local.ok">{{ t('st.quality.chain.localOk', { n: local.total, linked: local.linked }) }}</span>
      <span v-else class="st-chain__bad">{{ t('st.quality.chain.localBad', { n: local.problems.length }) }}</span>
      <span v-if="local.local" class="st-badge st-badge--warn">{{ t('st.quality.chain.unsynced', { n: local.local }, local.local) }}</span>
      <span v-if="local.unchained" class="st-badge">{{ t('st.quality.chain.unchained', { n: local.unchained }, local.unchained) }}</span>
      <span v-if="local.missing_seqs" class="st-badge">{{ t('st.quality.chain.missingSeqs', { n: local.missing_seqs }, local.missing_seqs) }}</span>
      <ul v-if="!local.ok" class="st-chain__errors st-mono">
        <li v-for="(p, i) in local.problems" :key="i">{{ t(`st.quality.chain.problem.${p.kind}`) }} — {{ p.event_id }}</li>
      </ul>
    </div>

    <button v-if="session.online" type="button" class="st-btn st-noprint" :disabled="serverState === 'loading'" @click="runServer">
      {{ t('st.quality.chain.recheck') }}
    </button>
  </section>
</template>

<style scoped>
.st-chain { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; border-width: 2px; border-style: solid; border-color: currentColor; }
.st-chain__main { display: flex; flex-direction: column; gap: 4px; flex: 1 1 320px; }
.st-chain__verdict { font-size: 1.25rem; }
.st-chain__local { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: 1 1 320px; color: var(--st-text); }
.st-chain__bad { color: var(--st-danger); font-weight: 700; }
.st-chain__errors { margin: 4px 0 0; padding-left: 18px; font-size: 0.85rem; overflow-wrap: anywhere; }
</style>
