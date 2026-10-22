<script setup lang="ts">
// "Complete step" with the reasons it is not possible yet listed right above the button.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Step, Uuid } from '../../domain/types'
import { useRegistryStore, useRunsStore, type Signer } from '../../stores'
import PinDialog from '../session/PinDialog.vue'
import { errorLines } from './errors'
import { offlineToolProblems } from './stepChecks'

const props = defineProps<{ runId: Uuid; step: Step; editable: boolean }>()
const emit = defineEmits<{ completed: [] }>()
const { t } = useI18n()
const runs = useRunsStore()
const registry = useRegistryStore()

const busy = ref(false)
const errors = ref<string[]>([])
const pinOpen = ref(false)

const problems = computed(() => {
  const sp = runs.projection(props.runId).value?.steps[props.step.id]
  const keys = [
    ...runs.validateComplete(props.runId, props.step.id),
    ...offlineToolProblems({
      runId: props.runId, step: props.step, projection: sp, events: runs.events(props.runId), ncrs: registry.ncrs,
      checkTool: (c, on) => registry.checkTool(c, on),
    }),
  ]
  return [...new Set(keys)].map((k) => t(k))
})

const disabled = computed(() => !props.editable || problems.value.length > 0 || busy.value)

async function complete(signer?: Signer) {
  pinOpen.value = false
  if (disabled.value) return
  busy.value = true
  errors.value = []
  try {
    await runs.completeStep(props.runId, props.step.id, signer)
    emit('completed')
  } catch (e) {
    errors.value = errorLines(e, t)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="st-card st-stack st-complete" data-test="complete-panel">
    <template v-if="problems.length">
      <p class="st-label">{{ t('st.run.complete.notYet') }}</p>
      <ul class="st-complete__problems" data-test="complete-problems">
        <li v-for="p in problems" :key="p">{{ p }}</li>
      </ul>
    </template>
    <p v-else-if="editable" class="st-alert st-alert--ok">{{ t('st.run.complete.ready') }}</p>
    <p v-for="e in errors" :key="e" class="st-alert st-alert--danger" role="alert">{{ e }}</p>
    <div class="st-row">
      <button type="button" class="st-btn st-btn--primary st-btn--lg st-complete__btn" :disabled="disabled" data-test="complete-step" @click="complete()">
        {{ t('st.run.complete.button') }}
      </button>
      <button type="button" class="st-btn" :disabled="disabled" data-test="complete-as" @click="pinOpen = true">
        {{ t('st.run.complete.asOther') }}
      </button>
    </div>
    <PinDialog :open="pinOpen" :title="t('st.run.complete.asOtherTitle')" @signed="complete" @close="pinOpen = false" />
  </section>
</template>

<style scoped>
.st-complete__problems { margin: 0; padding-left: 22px; color: var(--st-warn); font-weight: 600; }
.st-complete__problems li + li { margin-top: 4px; }
.st-complete__btn { flex: 1; min-width: 240px; }
</style>
