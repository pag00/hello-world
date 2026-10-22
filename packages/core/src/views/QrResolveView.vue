<script setup lang="ts">
// Target of printed QR labels (/q/ws/WS-03, /q/run/<id>, /q/part/<pn>/<serial>, /q/tool/<code>):
// resolves the label and replaces itself with the destination, or explains what it found.
import { watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { qrTargetFromRoute } from '../domain/qr'
import QrResultPanel from '../components/run/QrResultPanel.vue'
import { useQrNavigation } from '../components/run/useQrNavigation'

const { t } = useI18n()
const route = useRoute()
const qr = useQrNavigation()

watch(
  () => [route.params.kind, route.params.rest] as const,
  ([kind, rest]) => {
    if (typeof kind !== 'string') return
    const parts = Array.isArray(rest) ? rest.map(String) : typeof rest === 'string' ? rest : []
    // replace: the label URL should not stay in history (back must not re-resolve and jump again)
    void qr.handle(qrTargetFromRoute(kind, parts), { replace: true })
  },
  { immediate: true },
)
</script>

<template>
  <div class="st-page st-stack">
    <h1 class="st-h1">{{ t('st.run.qr.title') }}</h1>
    <p v-if="qr.busy.value || !qr.result.value" class="st-muted" data-test="qr-resolving">{{ t('st.run.qr.resolving') }}</p>
    <QrResultPanel v-else :result="qr.result.value" @choose-run="qr.chooseRun" @clear="$router.push({ name: 'st-home' })" />
  </div>
</template>
