import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SessionStore } from './contracts'
import type { User } from '../domain/types'
import { notImplemented } from './_stub'

export const useSessionStore = defineStore('st-session', (): SessionStore => {
  const user = ref<User | null>(null)
  return {
    user,
    deviceId: ref('00000000-0000-7000-8000-000000000000'),
    online: ref(navigator.onLine),
    pinSigners: ref([]),
    init: async () => {},
    login: () => notImplemented('session.login'),
    logout: () => notImplemented('session.logout'),
    hasRole: (role, u = user.value) => !!u?.roles.includes(role),
    verifyPin: () => notImplemented('session.verifyPin'),
    setPin: () => notImplemented('session.setPin'),
    defaultSigner: () => ({ user: user.value ?? notImplemented('session.defaultSigner (no user)'), auth_method: 'oidc' }),
  }
})
