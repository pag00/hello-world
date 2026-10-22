<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { applyUpdate, dismissPwaNotice, pwaState } from './pwa'

const { t } = useI18n()
</script>

<template>
  <RouterView />
  <div v-if="pwaState.needRefresh || pwaState.offlineReady" class="st-root app-notice-host">
    <div class="st-card st-stack app-notice" role="status" aria-live="polite" data-test="pwa-notice">
      <template v-if="pwaState.needRefresh">
        <strong>{{ t('st.device.app.updateAvailable') }}</strong>
        <span class="st-hint">{{ t('st.device.app.updateHint') }}</span>
        <div class="st-row">
          <button type="button" class="st-btn st-btn--primary" data-test="pwa-update" @click="applyUpdate">{{ t('st.device.app.updateNow') }}</button>
          <button type="button" class="st-btn" @click="dismissPwaNotice">{{ t('st.device.app.later') }}</button>
        </div>
      </template>
      <template v-else>
        <span>{{ t('st.device.app.offlineReady') }}</span>
        <div class="st-row">
          <button type="button" class="st-btn" @click="dismissPwaNotice">{{ t('st.device.app.dismiss') }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.app-notice-host {
  position: fixed; right: 16px; bottom: max(16px, env(safe-area-inset-bottom)); z-index: 900;
  background: transparent; max-width: min(420px, calc(100vw - 32px));
}
.app-notice { border-left: 4px solid var(--st-primary); }
</style>
