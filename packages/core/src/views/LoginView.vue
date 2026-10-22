<script setup lang="ts">
// Dev mode: pick a seeded user. OIDC / host auth: one sign-in button (redirects to the IdP).
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useStepTrackConfig } from '../config'
import { isDevAuthProvider } from '../auth/dev'
import type { AuthUser } from '../auth/types'
import { useSessionStore, useSyncStore } from '../stores'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const config = useStepTrackConfig()
const session = useSessionStore()
const sync = useSyncStore()

const dev = computed(() => (isDevAuthProvider(config.auth) ? config.auth : null))
const users = ref<AuthUser[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

function redirectTarget() {
  const r = route.query.redirect
  return typeof r === 'string' && r.startsWith('/') ? r : { name: 'st-home' }
}

async function loadUsers() {
  if (!dev.value) return
  loading.value = true
  error.value = null
  try {
    users.value = await dev.value.listUsers()
  } catch {
    error.value = t('st.session.login.loadFailed')
  } finally {
    loading.value = false
  }
}

async function pick(u: AuthUser) {
  dev.value!.selectUser(u)
  await session.refreshUser()
  void sync.syncNow()
  await router.replace(redirectTarget())
}

async function signIn() {
  error.value = null
  loading.value = true
  try {
    await session.login()
    // providers that do not redirect (host-supplied) resolve here
    if (session.user) await router.replace(redirectTarget())
  } catch {
    error.value = t('st.session.login.callbackFailed')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await session.ready()
  if (session.user) return void router.replace(redirectTarget())
  await loadUsers()
})
</script>

<template>
  <div class="st-page st-login">
    <div class="st-card st-stack st-login__card">
      <h1 class="st-h1">{{ t('st.common.appName') }}</h1>
      <p class="st-muted">{{ t('st.session.login.subtitle') }}</p>
      <p v-if="!sync.online" class="st-alert st-alert--warn">{{ t('st.session.login.offlineHint') }}</p>
      <p v-if="error" class="st-alert st-alert--danger" role="alert">{{ error }}</p>

      <template v-if="dev">
        <h2 class="st-h2">{{ t('st.session.login.chooseUser') }}</h2>
        <p class="st-hint">{{ t('st.session.login.devHint') }}</p>
        <p v-if="loading" class="st-muted">{{ t('st.common.loading') }}</p>
        <p v-else-if="!users.length && !error" class="st-muted">{{ t('st.session.login.noUsers') }}</p>
        <div class="st-login__users">
          <button v-for="u in users" :key="u.id" type="button" class="st-btn st-btn--lg st-login__user" :data-test="`dev-user-${u.id}`" @click="pick(u)">
            <span>{{ u.name }}</span>
            <span class="st-hint">{{ u.roles.map((r) => t(`st.session.roles.${r}`)).join(', ') }}</span>
          </button>
        </div>
        <button v-if="error" type="button" class="st-btn" @click="loadUsers">{{ t('st.common.retry') }}</button>
      </template>

      <button v-else type="button" class="st-btn st-btn--primary st-btn--lg st-btn--block" :disabled="loading || !sync.online" @click="signIn">
        {{ t('st.session.login.signIn') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.st-login { display: flex; justify-content: center; padding-top: 8vh; }
.st-login__card { width: min(640px, 100%); }
.st-login__users { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--st-gap); }
.st-login__user { flex-direction: column; align-items: flex-start; text-align: left; padding: 10px 16px; }
</style>
