<script setup lang="ts">
// Pick a user (filtered by role, excluding excludeUserIds) and confirm with PIN (offline) — or, for the
// logged-in user while online, confirm without PIN. Emits the resulting Signer. Used for sign-offs,
// inspector verification and supervisor actions.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Role, User, Uuid } from '../../domain/types'
import type { Signer } from '../../stores/contracts'
import { useRegistryStore, useSessionStore } from '../../stores'
import StDialog from '../StDialog.vue'

const props = defineProps<{ open: boolean; title?: string; role?: Role | null; excludeUserIds?: Uuid[] }>()
const emit = defineEmits<{ signed: [signer: Signer]; close: [] }>()

const { t } = useI18n()
const session = useSessionStore()
const registry = useRegistryStore()

const selected = ref<User | null>(null)
const pin = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null

const excluded = computed(() => new Set(props.excludeUserIds ?? []))
const eligible = (u: User) => !excluded.value.has(u.id) && (!props.role || u.roles.includes(props.role))

const me = computed(() => (session.user && eligible(session.user) ? session.user : null))
const canSignAsMe = computed(() => !!me.value && session.online)

const candidates = computed(() => {
  const list = registry.users.filter(eligible)
  // the signed-in user may be missing from the pulled list on a fresh device
  if (me.value && !list.some((u) => u.id === me.value!.id)) list.unshift(me.value)
  return list
})

const lockedFor = computed(() => {
  if (!selected.value) return 0
  const until = session.pinLockedUntil(selected.value.id)
  return until > now.value ? Math.ceil((until - now.value) / 1000) : 0
})

function reset() {
  selected.value = null
  pin.value = ''
  error.value = null
  busy.value = false
}

watch(
  () => props.open,
  (open) => {
    reset()
    if (ticker) clearInterval(ticker)
    ticker = open ? setInterval(() => (now.value = Date.now()), 1000) : null
  },
  { immediate: true },
)
onBeforeUnmount(() => ticker && clearInterval(ticker))

function choose(u: User) {
  if (!u.pin_verifier) return
  selected.value = u
  pin.value = ''
  error.value = null
}

function signAsMe() {
  if (!canSignAsMe.value) return
  emit('signed', session.defaultSigner())
}

function press(d: string) {
  error.value = null
  if (pin.value.length < 12) pin.value += d
}

function backspace() {
  pin.value = pin.value.slice(0, -1)
}

async function confirm() {
  if (!selected.value || pin.value.length < 6 || busy.value || lockedFor.value) return
  busy.value = true
  try {
    const signer = await session.verifyPin(selected.value.id, pin.value)
    if (signer) emit('signed', signer)
    else {
      error.value = session.pinLockedUntil(selected.value.id) ? null : t('st.session.pin.wrong')
      pin.value = ''
    }
  } finally {
    busy.value = false
  }
}

function onKey(e: KeyboardEvent) {
  if (!props.open || !selected.value) return
  if (/^[0-9]$/.test(e.key)) press(e.key)
  else if (e.key === 'Backspace') backspace()
  else if (e.key === 'Enter') void confirm()
}
watch(selected, (s) => {
  if (s) window.addEventListener('keydown', onKey)
  else window.removeEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
</script>

<template>
  <StDialog :open="open" :title="title ?? t('st.session.pin.title')" @close="emit('close')">
    <p v-if="role" class="st-hint">{{ t('st.session.pin.requiredRole', { role: t(`st.session.roles.${role}`) }) }}</p>

    <template v-if="!selected">
      <button v-if="canSignAsMe" type="button" class="st-btn st-btn--primary st-btn--lg st-btn--block" data-test="sign-as-me" @click="signAsMe">
        {{ t('st.session.pin.signAsMe', { name: me!.name }) }}
      </button>
      <p class="st-label">{{ canSignAsMe ? t('st.session.pin.otherUser') : t('st.session.pin.chooseUser') }}</p>
      <p v-if="!candidates.length" class="st-alert st-alert--warn">{{ t('st.session.pin.noUsers') }}</p>
      <div class="st-pin__users">
        <button
          v-for="u in candidates"
          :key="u.id"
          type="button"
          class="st-btn st-pin__user"
          :disabled="!u.pin_verifier"
          :data-test="`user-${u.id}`"
          @click="choose(u)"
        >
          <span>{{ u.name }}</span>
          <span v-if="!u.pin_verifier" class="st-hint">{{ t('st.session.pin.noPin') }}</span>
        </button>
      </div>
    </template>

    <template v-else>
      <p class="st-label">{{ t('st.session.pin.enterPin', { name: selected.name }) }}</p>
      <div class="st-pin__display st-mono" aria-live="polite" data-test="pin-display">
        <span v-for="i in Math.max(6, pin.length)" :key="i" class="st-pin__dot" :class="{ 'st-pin__dot--on': i <= pin.length }" />
      </div>
      <p v-if="lockedFor" class="st-alert st-alert--danger" role="alert">{{ t('st.session.pin.locked', { s: lockedFor }) }}</p>
      <p v-else-if="error" class="st-alert st-alert--danger" role="alert">{{ error }}</p>
      <div class="st-pin__pad">
        <button v-for="d in digits" :key="d" type="button" class="st-btn st-pin__key" :disabled="!!lockedFor" @click="press(d)">{{ d }}</button>
        <button type="button" class="st-btn st-pin__key" :aria-label="t('st.session.pin.clear')" @click="pin = ''">C</button>
        <button type="button" class="st-btn st-pin__key" :disabled="!!lockedFor" @click="press('0')">0</button>
        <button type="button" class="st-btn st-pin__key" :aria-label="t('st.session.pin.backspace')" @click="backspace">⌫</button>
      </div>
    </template>

    <template #actions>
      <button v-if="selected" type="button" class="st-btn" @click="selected = null">{{ t('st.session.pin.back') }}</button>
      <button v-else type="button" class="st-btn" @click="emit('close')">{{ t('st.common.cancel') }}</button>
      <button
        v-if="selected"
        type="button"
        class="st-btn st-btn--primary"
        data-test="pin-confirm"
        :disabled="pin.length < 6 || busy || !!lockedFor"
        @click="confirm"
      >
        {{ t('st.session.pin.confirm') }}
      </button>
    </template>
  </StDialog>
</template>

<style scoped>
.st-pin__users { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--st-gap); }
.st-pin__user { flex-direction: column; min-height: 64px; }
.st-pin__display { display: flex; justify-content: center; gap: 12px; padding: 12px 0; }
.st-pin__dot { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--st-border); }
.st-pin__dot--on { background: var(--st-text); border-color: var(--st-text); }
.st-pin__pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.st-pin__key { min-height: 72px; font-size: 1.6rem; }
</style>
