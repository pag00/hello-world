<script setup lang="ts">
// Offline checkout of a whole run (§6). Without a checkout a run is read-only on a tablet that loses
// its connection; with one, no other device can work on the run until it is released.
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ApiError } from '../../api/client'
import type { Uuid } from '../../domain/types'
import { useRunsStore, useSessionStore, useSyncStore } from '../../stores'
import { PendingSyncError } from '../../sync/engine'
import { errorLines } from './errors'
import { fmtDateTime } from './format'

const props = defineProps<{ runId: Uuid; closed: boolean }>()
const { t, locale } = useI18n()
const runs = useRunsStore()
const session = useSessionStore()
const sync = useSyncStore()

const HOURS = [12, 24, 72] as const
const hours = ref<number>(12)
const busy = ref(false)
const errors = ref<string[]>([])
const info = ref<string | null>(null)

const now = ref(Date.now())
const ticker = setInterval(() => (now.value = Date.now()), 30_000)
onBeforeUnmount(() => clearInterval(ticker))

const co = computed(() => runs.checkoutOf(props.runId))
const live = computed(() => !!co.value && Date.parse(co.value.expires_at) > now.value)
const mine = computed(() => live.value && co.value!.holder_device === session.deviceId)
const releaseRequested = computed(() => !!(co.value as { release_requested?: boolean } | null)?.release_requested)
const implicit = computed(() => !!(co.value as { implicit?: boolean } | null)?.implicit)

async function checkout() {
  busy.value = true
  errors.value = []
  info.value = null
  try {
    await runs.checkout(props.runId, hours.value)
  } catch (e) {
    errors.value = e instanceof ApiError && e.status === 409 ? [t('st.run.checkout.refused')] : errorLines(e, t)
  } finally {
    busy.value = false
  }
}

async function release() {
  busy.value = true
  errors.value = []
  info.value = null
  try {
    await runs.releaseCheckout(props.runId)
    info.value = t('st.run.checkout.released')
  } catch (e) {
    if (e instanceof PendingSyncError) info.value = t('st.run.checkout.releasePending')
    else errors.value = errorLines(e, t)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="st-card st-stack" data-test="checkout-panel">
    <h2 class="st-h2">{{ t('st.run.checkout.title') }}</h2>

    <template v-if="mine">
      <p class="st-alert st-alert--ok" data-test="checkout-mine">
        {{ t('st.run.checkout.mine', { until: fmtDateTime(co!.expires_at, locale) }) }}
      </p>
      <p v-if="implicit" class="st-hint">{{ t('st.run.checkout.implicit') }}</p>
      <p v-if="releaseRequested" class="st-alert st-alert--info" data-test="checkout-release-requested">
        {{ t('st.run.checkout.releasePending') }}
        <template v-if="sync.pendingEvents"> {{ t('st.run.checkout.pendingCount', { n: sync.pendingEvents }, sync.pendingEvents) }}</template>
      </p>
      <template v-else>
        <p class="st-hint">{{ t('st.run.checkout.releaseExplain') }}</p>
        <div>
          <button type="button" class="st-btn" :disabled="busy || !session.online" data-test="checkout-release" @click="release">
            {{ t('st.run.checkout.release') }}
          </button>
        </div>
        <p v-if="!session.online" class="st-hint">{{ t('st.run.checkout.releaseOnline') }}</p>
      </template>
    </template>

    <template v-else-if="live">
      <p class="st-alert st-alert--warn">{{ t('st.run.checkout.other', { until: fmtDateTime(co!.expires_at, locale) }) }}</p>
    </template>

    <template v-else-if="!closed">
      <p class="st-hint">{{ t('st.run.checkout.explain') }}</p>
      <div class="st-row">
        <label class="st-row">
          <span class="st-label st-checkout__label">{{ t('st.run.checkout.duration') }}</span>
          <select v-model.number="hours" class="st-select st-checkout__select" :disabled="busy || !session.online">
            <option v-for="h in HOURS" :key="h" :value="h">{{ t('st.run.checkout.hours', { n: h }) }}</option>
          </select>
        </label>
        <button type="button" class="st-btn st-btn--primary" :disabled="busy || !session.online" data-test="checkout" @click="checkout">
          {{ t('st.run.checkout.checkout') }}
        </button>
      </div>
      <p v-if="!session.online" class="st-alert st-alert--warn">{{ t('st.run.checkout.offlineCannot') }}</p>
    </template>

    <p v-if="info" class="st-alert st-alert--info" role="status">{{ info }}</p>
    <p v-for="e in errors" :key="e" class="st-alert st-alert--danger" role="alert">{{ e }}</p>
  </section>
</template>

<style scoped>
.st-checkout__label { margin: 0; }
.st-checkout__select { width: auto; min-width: 10ch; }
</style>
