<script setup lang="ts">
// Account, offline PIN, language, sync details (incl. rejected records) and storage.
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useRegistryStore, useSessionStore, useSyncStore } from '../stores'
import { isValidPin } from '../auth/pin'
import { saveLocale } from '../plugin'
import { SUPPORTED_LOCALES, type Locale } from '../i18n'

const { t, locale } = useI18n()
const router = useRouter()
const session = useSessionStore()
const sync = useSyncStore()
const registry = useRegistryStore()

// ---- PIN
const pin1 = ref('')
const pin2 = ref('')
const pinMsg = ref<{ tone: 'ok' | 'danger'; text: string } | null>(null)
const pinBusy = ref(false)
const ownVerifier = computed(() => registry.users.find((u) => u.id === session.user?.id)?.pin_verifier ?? session.user?.pin_verifier ?? null)

async function savePin() {
  pinMsg.value = null
  if (!isValidPin(pin1.value)) return void (pinMsg.value = { tone: 'danger', text: t('st.session.pin.invalidFormat') })
  if (pin1.value !== pin2.value) return void (pinMsg.value = { tone: 'danger', text: t('st.session.pin.mismatch') })
  pinBusy.value = true
  try {
    await session.setPin(pin1.value)
    pin1.value = pin2.value = ''
    pinMsg.value = { tone: 'ok', text: t('st.session.pin.saved') }
  } catch {
    pinMsg.value = { tone: 'danger', text: sync.online ? t('st.session.errors.unknown') : t('st.session.pin.onlineOnly') }
  } finally {
    pinBusy.value = false
  }
}

// ---- language
function setLocale(l: Locale) {
  locale.value = l
  saveLocale(l)
}

// ---- storage
const storage = ref<{ usage: number; quota: number } | null>(null)
const persisted = ref<boolean | null>(null)
const persistDenied = ref(false)

function fmtBytes(n: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
}

async function refreshStorage() {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined
  if (s?.estimate) {
    const e = await s.estimate()
    storage.value = { usage: e.usage ?? 0, quota: e.quota ?? 0 }
  }
  if (s?.persisted) persisted.value = await s.persisted()
}

async function requestPersist() {
  const ok = (await navigator.storage?.persist?.()) ?? false
  persisted.value = ok
  persistDenied.value = !ok
}

onMounted(() => {
  void refreshStorage()
  void sync.loadRejected()
})

// ---- sync
function fmtTs(ts: string | null) {
  return ts ? new Date(ts).toLocaleString(locale.value) : t('st.session.sync.never')
}

async function logout() {
  await session.logout()
  await router.replace({ name: 'st-login' })
}
</script>

<template>
  <div class="st-page st-stack">
    <h1 class="st-h1">{{ t('st.session.settings.title') }}</h1>

    <section class="st-card st-stack">
      <h2 class="st-h2">{{ t('st.session.settings.account') }}</h2>
      <template v-if="session.user">
        <div class="st-row">
          <strong class="st-settings__name">{{ session.user.name }}</strong>
          <span v-if="session.user.email" class="st-muted">{{ session.user.email }}</span>
        </div>
        <div class="st-row">
          <span class="st-label">{{ t('st.session.settings.roles') }}</span>
          <span v-for="r in session.user.roles" :key="r" class="st-badge st-badge--info">{{ t(`st.session.roles.${r}`) }}</span>
        </div>
      </template>
      <div v-if="session.authExpired" class="st-alert st-alert--warn st-row">
        <span>{{ t('st.session.settings.authExpired') }}</span>
        <button type="button" class="st-btn" :disabled="!sync.online" @click="session.login()">{{ t('st.session.settings.signInAgain') }}</button>
      </div>
      <p v-if="sync.pendingEvents" class="st-hint">{{ t('st.session.settings.logoutPending', { n: sync.pendingEvents }) }}</p>
      <div><button type="button" class="st-btn st-btn--danger" data-test="logout" @click="logout">{{ t('st.session.settings.logout') }}</button></div>
    </section>

    <section class="st-card st-stack">
      <h2 class="st-h2">{{ t('st.session.settings.pinTitle') }}</h2>
      <p class="st-hint">{{ ownVerifier ? t('st.session.settings.pinSet') : t('st.session.settings.pinNotSet') }}</p>
      <p v-if="!sync.online" class="st-alert st-alert--info">{{ t('st.session.pin.onlineOnly') }}</p>
      <form class="st-settings__pin" @submit.prevent="savePin">
        <label class="st-stack">
          <span class="st-label">{{ t('st.session.pin.newPin') }}</span>
          <input v-model="pin1" class="st-input st-input--num" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12" pattern="[0-9]*" :disabled="!sync.online" />
        </label>
        <label class="st-stack">
          <span class="st-label">{{ t('st.session.pin.repeatPin') }}</span>
          <input v-model="pin2" class="st-input st-input--num" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12" pattern="[0-9]*" :disabled="!sync.online" />
        </label>
        <button type="submit" class="st-btn st-btn--primary" :disabled="!sync.online || pinBusy || !pin1">{{ t('st.session.pin.save') }}</button>
      </form>
      <p v-if="pinMsg" class="st-alert" :class="`st-alert--${pinMsg.tone}`" role="status">{{ pinMsg.text }}</p>
    </section>

    <section class="st-card st-stack">
      <h2 class="st-h2">{{ t('st.session.settings.language') }}</h2>
      <div class="st-row" role="radiogroup" :aria-label="t('st.session.settings.language')">
        <button
          v-for="l in SUPPORTED_LOCALES"
          :key="l"
          type="button"
          role="radio"
          class="st-btn"
          :class="{ 'st-btn--primary': locale === l }"
          :aria-checked="locale === l"
          @click="setLocale(l)"
        >
          {{ t(`st.session.settings.languages.${l}`) }}
        </button>
      </div>
    </section>

    <section class="st-card st-stack">
      <div class="st-row">
        <h2 class="st-h2">{{ t('st.session.sync.title') }}</h2>
        <span class="st-spacer" />
        <button type="button" class="st-btn st-btn--primary" :disabled="sync.syncing || !session.user" @click="sync.syncNow()">
          {{ sync.syncing ? t('st.session.sync.syncing') : t('st.session.sync.syncNow') }}
        </button>
      </div>
      <dl class="st-settings__dl">
        <dt>{{ t('st.common.online') }}</dt>
        <dd><span class="st-badge" :class="sync.online ? 'st-badge--ok' : 'st-badge--warn'">{{ sync.online ? t('st.session.sync.online') : t('st.session.sync.offline') }}</span></dd>
        <dt>{{ t('st.session.sync.lastSync') }}</dt>
        <dd>{{ fmtTs(sync.lastSyncAt) }}</dd>
        <dt>{{ t('st.session.sync.title') }}</dt>
        <dd>
          {{ t('st.session.sync.pendingEvents', { n: sync.pendingEvents }, sync.pendingEvents) }} ·
          {{ t('st.session.sync.pendingBlobs', { n: sync.pendingBlobs }, sync.pendingBlobs) }}
        </dd>
        <template v-if="sync.lastError">
          <dt>{{ t('st.session.sync.error') }}</dt>
          <dd class="st-settings__err">{{ sync.lastErrorCode === 'auth' ? t('st.session.sync.authError') : sync.lastError }}</dd>
        </template>
        <dt>{{ t('st.session.settings.deviceId') }}</dt>
        <dd class="st-mono st-settings__id">{{ session.deviceId }}</dd>
      </dl>

      <h3 id="st-rejected" class="st-h2">{{ t('st.session.sync.rejectedTitle') }}</h3>
      <p v-if="!sync.rejected.length" class="st-muted">{{ t('st.session.sync.noRejected') }}</p>
      <template v-else>
        <p class="st-alert st-alert--danger">{{ t('st.session.sync.rejectedHint') }}</p>
        <div class="st-settings__scroll">
          <table class="st-table">
            <thead>
              <tr>
                <th>{{ t('st.session.sync.colType') }}</th>
                <th>{{ t('st.session.sync.colRun') }}</th>
                <th>{{ t('st.session.sync.colTime') }}</th>
                <th>{{ t('st.session.sync.colError') }}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in sync.rejected" :key="r.event_id" :data-test="`rejected-${r.event_id}`">
                <td class="st-mono">{{ r.event.type }}</td>
                <td>
                  <RouterLink :to="{ name: 'st-run', params: { runId: r.run_id } }" class="st-mono">{{ r.run_id.slice(-8) }}</RouterLink>
                </td>
                <td>{{ fmtTs(r.event.client_ts) }}</td>
                <td>{{ r.error }}</td>
                <td>
                  <span v-if="r.acknowledged" class="st-badge">{{ t('st.session.sync.acknowledged') }}</span>
                  <button v-else type="button" class="st-btn" @click="sync.acknowledgeRejected(r.event_id)">{{ t('st.session.sync.acknowledge') }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>

    <section class="st-card st-stack">
      <h2 class="st-h2">{{ t('st.session.settings.storage') }}</h2>
      <p v-if="storage">{{ t('st.session.settings.storageUsed', { used: fmtBytes(storage.usage), quota: fmtBytes(storage.quota) }) }}</p>
      <p v-else class="st-muted">{{ t('st.session.settings.storageUnknown') }}</p>
      <p v-if="persisted" class="st-alert st-alert--ok">{{ t('st.session.settings.persisted') }}</p>
      <template v-else-if="persisted === false">
        <p class="st-alert st-alert--warn">{{ t('st.session.settings.notPersisted') }}</p>
        <div><button type="button" class="st-btn" @click="requestPersist">{{ t('st.session.settings.persist') }}</button></div>
        <p v-if="persistDenied" class="st-hint">{{ t('st.session.settings.persistDenied') }}</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.st-settings__name { font-size: 1.15rem; }
.st-settings__pin { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--st-gap); align-items: end; }
.st-settings__dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 0; }
.st-settings__dl dt { color: var(--st-text-muted); font-weight: 600; }
.st-settings__dl dd { margin: 0; }
.st-settings__err { color: var(--st-danger); word-break: break-word; }
.st-settings__id { word-break: break-all; }
.st-settings__scroll { overflow-x: auto; }
</style>
