<script setup lang="ts">
// CONTRACT (core-data workstream implements): pick a user (filtered by role, excluding excludeUserIds)
// and confirm with PIN (offline) — or, for the logged-in user while online, confirm without PIN.
// Emits the resulting Signer. Used for sign-offs, inspector verification and supervisor actions.
import type { Role, Uuid } from '../../domain/types'
import type { Signer } from '../../stores/contracts'
defineProps<{ open: boolean; title?: string; role?: Role | null; excludeUserIds?: Uuid[] }>()
defineEmits<{ signed: [signer: Signer]; close: [] }>()
</script>

<template>
  <div />
</template>
