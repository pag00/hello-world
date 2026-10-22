<script setup lang="ts">
// OIDC redirect target: finish the code exchange, load /me, return to where sign-in started.
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useStepTrackConfig } from '../config'
import { useSessionStore, useSyncStore } from '../stores'

const { t } = useI18n()
const router = useRouter()
const config = useStepTrackConfig()
const session = useSessionStore()
const sync = useSyncStore()
const failed = ref(false)

onMounted(async () => {
  try {
    await config.auth.handleCallback?.()
    await session.ready()
    await session.refreshUser()
    void sync.syncNow()
    const auth = config.auth as { consumeReturnPath?: () => string | null }
    const back = auth.consumeReturnPath?.()
    // never bounce back into the callback or login page
    const safe = back && back.startsWith('/') && !/\/(auth\/callback|login)(\?|$)/.test(back) ? back : null
    await router.replace(safe ?? { name: 'st-home' })
  } catch {
    failed.value = true
  }
})
</script>

<template>
  <div class="st-page">
    <div class="st-card st-stack">
      <template v-if="!failed">
        <p>{{ t('st.session.login.callbackProcessing') }}</p>
      </template>
      <template v-else>
        <p class="st-alert st-alert--danger" role="alert">{{ t('st.session.login.callbackFailed') }}</p>
        <RouterLink :to="{ name: 'st-login' }" class="st-btn st-btn--primary">{{ t('st.session.login.backToLogin') }}</RouterLink>
      </template>
    </div>
  </div>
</template>
