<script setup lang="ts">
// Layout wrapper for all StepTrack routes: scoping root, top bar with section nav and sync status.
// When embedded, the host's own chrome surrounds this; the bar stays compact.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores'
import SyncStatusBadge from './SyncStatusBadge.vue'

const { t } = useI18n()
const session = useSessionStore()

const nav = computed(() => {
  const items = [
    { name: 'st-home', label: t('st.common.nav.home') },
    { name: 'st-runs', label: t('st.common.nav.runs') },
    { name: 'st-procedures', label: t('st.common.nav.procedures') },
    { name: 'st-ncrs', label: t('st.common.nav.ncrs') },
  ]
  if (session.hasRole('admin')) {
    items.push({ name: 'st-tools', label: t('st.common.nav.tools') }, { name: 'st-workstations', label: t('st.common.nav.workstations') })
  }
  items.push({ name: 'st-settings', label: t('st.common.nav.settings') })
  return items
})
</script>

<template>
  <div class="st-root st-shell">
    <header class="st-shell__bar st-noprint">
      <nav class="st-shell__nav">
        <RouterLink v-for="n in nav" :key="n.name" :to="{ name: n.name }" class="st-shell__link">{{ n.label }}</RouterLink>
      </nav>
      <span class="st-spacer" />
      <SyncStatusBadge />
    </header>
    <main class="st-shell__main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.st-shell { min-height: 100%; display: flex; flex-direction: column; }
.st-shell__bar {
  display: flex; align-items: center; gap: 8px; padding: 6px 12px;
  background: var(--st-surface); border-bottom: 1px solid var(--st-border);
  position: sticky; top: 0; z-index: 10;
}
.st-shell__nav { display: flex; gap: 4px; overflow-x: auto; }
.st-shell__link {
  display: inline-flex; align-items: center; min-height: var(--st-touch); padding: 0 12px;
  border-radius: var(--st-radius); color: var(--st-text-muted); text-decoration: none; font-weight: 600; white-space: nowrap;
}
.st-shell__link.router-link-exact-active, .st-shell__link.router-link-active:not([href$='/']) { color: var(--st-primary); background: var(--st-surface-2); }
.st-shell__main { flex: 1; }
</style>
