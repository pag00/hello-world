<script setup lang="ts">
// Dispatches one procedure input to its field component.
import type { Input, InputProjection, Uuid } from '../../../domain/types'
import CheckField from './CheckField.vue'
import NumberField from './NumberField.vue'
import PhotoField from './PhotoField.vue'
import ScanField from './ScanField.vue'
import SignoffField from './SignoffField.vue'
import TextField from './TextField.vue'

defineProps<{ runId: Uuid; stepId: Uuid; input: Input; state?: InputProjection; editable: boolean }>()
const emit = defineEmits<{ raiseNcr: [req: { inputId: Uuid; prefill: string }] }>()
</script>

<template>
  <CheckField v-if="input.type === 'check'" :run-id="runId" :step-id="stepId" :input="input" :state="state" :editable="editable" />
  <TextField v-else-if="input.type === 'text'" :run-id="runId" :step-id="stepId" :input="input" :state="state" :editable="editable" />
  <NumberField
    v-else-if="input.type === 'number'"
    :run-id="runId" :step-id="stepId" :input="input" :state="state" :editable="editable"
    @raise-ncr="(r) => emit('raiseNcr', r)"
  />
  <PhotoField v-else-if="input.type === 'photo'" :run-id="runId" :step-id="stepId" :input="input" :state="state" :editable="editable" />
  <ScanField
    v-else-if="input.type === 'scan'"
    :run-id="runId" :step-id="stepId" :input="input" :state="state" :editable="editable"
    @raise-ncr="(r) => emit('raiseNcr', r)"
  />
  <SignoffField v-else-if="input.type === 'signoff'" :run-id="runId" :step-id="stepId" :input="input" :state="state" :editable="editable" />
</template>
