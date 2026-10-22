<script setup lang="ts">
// Personal sign-off. The signer confirms identity in the PIN dialog (or as the signed-in user while
// online); the event carries who signed and how (§8), the value is just `true`.
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SignoffInput } from '../../../domain/types'
import { useRegistryStore, type Signer } from '../../../stores'
import PinDialog from '../../session/PinDialog.vue'
import FieldFrame from './FieldFrame.vue'
import RecordedMeta from './RecordedMeta.vue'
import { useField, type FieldProps } from './useField'

const props = defineProps<FieldProps<SignoffInput>>()
const { t } = useI18n()
const registry = useRegistryStore()
const f = useField(props)
const { busy, errors, currentEvent, history, hasValue } = f
const dialog = ref(false)

async function onSigned(signer: Signer) {
  dialog.value = false
  await f.record(true, 'manual', { signer })
}
</script>

<template>
  <FieldFrame :input="input" :errors="errors" :tone="hasValue ? 'ok' : null">
    <p v-if="input.role" class="st-hint">{{ t('st.run.signoff.requiresRole', { role: t(`st.session.roles.${input.role}`) }) }}</p>
    <p v-if="hasValue && currentEvent" class="st-signoff__done" data-test="signoff-done">
      <span aria-hidden="true">✓</span> {{ t('st.run.signoff.signedBy', { name: registry.userName(currentEvent.actor_id) }) }}
    </p>
    <RecordedMeta :event="currentEvent" :history="history" />
    <button
      v-if="!hasValue && editable"
      type="button"
      class="st-btn st-btn--primary st-btn--lg"
      :disabled="busy"
      data-test="signoff"
      @click="dialog = true"
    >
      {{ t('st.run.signoff.sign') }}
    </button>
    <p v-else-if="!hasValue" class="st-muted">{{ t('st.run.value.none') }}</p>
    <PinDialog :open="dialog" :title="t('st.run.signoff.dialogTitle', { label: input.label })" :role="input.role ?? null" @signed="onSigned" @close="dialog = false" />
  </FieldFrame>
</template>

<style scoped>
.st-signoff__done { margin: 0; font-size: 1.2rem; font-weight: 700; color: var(--st-ok); }
</style>
