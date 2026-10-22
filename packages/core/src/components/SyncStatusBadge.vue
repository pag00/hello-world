<script setup lang="ts">
// Compact sync indicator for the shell bar: online state, pending uploads, rejected records, last error.
// Tap = sync now. Rejected records link to settings, where they are listed.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSyncStore } from '../stores'

const { t } = useI18n()
const sync = useSyncStore()

const tone = computed(() => {
  if (sync.rejectedCount > 0 || sync.lastErrorCode === 'auth') return 'danger'
  if (!sync.online) return 'warn'
  if (sync.lastError) return 'warn'
  if (sync.pendingEvents + sync.pendingBlobs > 0) return 'info'
  return 'ok'
})

const label = computed(() => {
  if (sync.syncing) return t('st.session.sync.syncing')
  if (sync.lastErrorCode === 'auth') return t('st.session.sync.authError')
  const parts: string[] = [sync.online ? t('st.session.sync.online') : t('st.session.sync.offline')]
  if (sync.pendingEvents) parts.push(t('st.session.sync.pendingEvents', { n: sync.pendingEvents }, sync.pendingEvents))
  if (sync.pendingBlobs) parts.push(t('st.session.sync.pendingBlobs', { n: sync.pendingBlobs }, sync.pendingBlobs))
  if (!sync.pendingEvents && !sync.pendingBlobs && sync.online && !sync.lastError) parts.push(t('st.session.sync.upToDate'))
  return parts.join(' · ')
})

function syncNow() {
  void sync.syncNow()
}
</script>

<template>
  <span class="st-sync">
    <button
      type="button"
      class="st-sync__btn"
      :class="`st-sync__btn--${tone}`"
      :aria-label="t('st.session.sync.badgeLabel', { status: label })"
      :title="sync.lastError ?? undefined"
      :aria-busy="sync.syncing"
      @click="syncNow"
    >
      <span class="st-sync__dot" :class="{ 'st-sync__dot--spin': sync.syncing }" aria-hidden="true" />
      <span class="st-sync__label">{{ label }}</span>
    </button>
    <RouterLink v-if="sync.rejectedCount > 0" :to="{ name: 'st-settings', hash: '#st-rejected' }" class="st-badge st-badge--danger st-sync__rejected">
      {{ t('st.session.sync.rejected', { n: sync.rejectedCount }, sync.rejectedCount) }}
    </RouterLink>
  </span>
</template>

<style scoped>
.st-sync { display: inline-flex; align-items: center; gap: 6px; }
.st-sync__btn {
  display: inline-flex; align-items: center; gap: 8px; min-height: var(--st-touch); padding: 0 14px;
  border-radius: 999px; border: 1px solid transparent; font: inherit; font-weight: 700; font-size: 0.9rem; cursor: pointer;
  background: var(--st-surface-2); color: var(--st-text-muted); white-space: nowrap;
}
.st-sync__btn--ok { background: var(--st-ok-bg); color: var(--st-ok); }
.st-sync__btn--info { background: var(--st-info-bg); color: var(--st-info); }
.st-sync__btn--warn { background: var(--st-warn-bg); color: var(--st-warn); }
.st-sync__btn--danger { background: var(--st-danger-bg); color: var(--st-danger); }
.st-sync__btn:focus-visible { outline: 3px solid var(--st-primary); outline-offset: 2px; }
.st-sync__dot { width: 12px; height: 12px; border-radius: 50%; background: currentColor; flex: none; }
.st-sync__dot--spin { background: transparent; border: 3px solid currentColor; border-right-color: transparent; animation: st-sync-spin 0.9s linear infinite; }
.st-sync__rejected { min-height: var(--st-touch); padding: 0 12px; text-decoration: none; }
@keyframes st-sync-spin { to { transform: rotate(360deg); } }
@media (max-width: 600px) {
  .st-sync__label { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; }
}
</style>
