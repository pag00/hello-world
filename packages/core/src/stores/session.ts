import { defineStore } from 'pinia'
import { ref, type Ref } from 'vue'
import type { SessionStore, Signer } from './contracts'
import type { Role, User, Uuid } from '../domain/types'
import { getStepTrackConfig } from '../config'
import { ApiError, OfflineError } from '../api/client'
import { api } from '../api/endpoints'
import { isValidPin, verifyPin as verifyPinHash } from '../auth/pin'
import type { AuthUser } from '../auth/types'
import { uuidv7 } from '../domain/uuid'
import { bindRuntimeHooks, getDb, getEngine, syncState } from '../sync/runtime'
import { useProceduresStore } from './procedures'
import { useRegistryStore } from './registry'
import { useRunsStore } from './runs'
import { useSyncStore } from './sync'

interface CachedUser {
  /** AuthProvider user id (OIDC sub / dev id) the cached StepTrack user belongs to */
  auth_key: string
  user: User
}

const PIN_MAX_FAILURES = 5
const PIN_LOCKOUT_MS = 60_000

export interface SessionStoreImpl extends SessionStore {
  /** resolves once init() has restored the local session (does not wait for the network) */
  ready(): Promise<void>
  initialized: Ref<boolean>
  /** server rejected our credentials; local work continues, sign-in needed to sync */
  authExpired: Ref<boolean>
  /** re-read the signed-in user from the AuthProvider and (online) GET /me */
  refreshUser(): Promise<void>
  /** epoch ms until which PIN entry for this user is locked after repeated failures, or 0 */
  pinLockedUntil(userId: Uuid): number
  clearPinSigners(): void
}

export const useSessionStore = defineStore('st-session', (): SessionStoreImpl => {
  const user = ref<User | null>(null)
  const deviceId = ref<Uuid>('')
  const online = syncState.online
  const pinSigners = ref<User[]>([])
  const initialized = ref(false)
  const authExpired = ref(false)
  const pinFailures = new Map<Uuid, { count: number; until: number }>()

  let readyResolve!: () => void
  const readyPromise = new Promise<void>((r) => (readyResolve = r))
  let initPromise: Promise<void> | null = null

  function fromAuthUser(a: AuthUser): User {
    return { id: a.id, name: a.name, email: a.email ?? null, roles: [...a.roles] }
  }

  async function cacheUser(authKey: string, u: User | null) {
    const db = getDb()
    if (u) {
      await db.setMeta('user', { auth_key: authKey, user: u } satisfies CachedUser)
      await db.users.put(u)
    } else {
      await db.meta.delete('user')
    }
  }

  async function refreshUser(): Promise<void> {
    const auth = getStepTrackConfig().auth
    let authUser: AuthUser | null = null
    try {
      authUser = await auth.getUser()
    } catch {
      authUser = null
    }
    if (!authUser) {
      user.value = null
      return
    }
    const cached = await getDb().getMeta<CachedUser>('user')
    const fallback = cached && cached.auth_key === authUser.id ? cached.user : fromAuthUser(authUser)
    if (cached && cached.auth_key === authUser.id) user.value = cached.user
    try {
      const me = await api.me()
      user.value = me
      authExpired.value = false
      await cacheUser(authUser.id, me)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) authExpired.value = true
      else if (e instanceof OfflineError) syncState.online.value = false
      // never block offline use: keep the cached profile, or derive one from the provider
      user.value = fallback
    }
  }

  async function doInit() {
    const db = getDb()
    let id = await db.getMeta<string>('device_id')
    if (!id) {
      id = uuidv7()
      await db.setMeta('device_id', id)
    }
    deviceId.value = id

    const procedures = useProceduresStore()
    const registry = useRegistryStore()
    const runs = useRunsStore()
    const sync = useSyncStore()

    bindRuntimeHooks({
      deviceId: () => deviceId.value,
      userId: () => user.value?.id ?? null,
      onPulled: async (s) => {
        await Promise.all([
          s.procedures || s.revisions ? procedures.hydrate() : null,
          registry.hydrate(),
          runs.applyPulled(s.eventRunIds),
        ])
      },
      onPushed: async (s) => {
        await runs.applyPushed(s)
        await sync.loadRejected()
      },
      onLocalChange: async () => {
        await Promise.all([runs.reloadLocal(), sync.loadRejected()])
      },
    })

    // local data first: the tablet must be usable within a second, with or without network
    await Promise.all([procedures.hydrate(), registry.hydrate(), runs.hydrate(), sync.loadRejected()])

    const auth = getStepTrackConfig().auth
    let authUser: AuthUser | null = null
    try {
      authUser = await auth.getUser()
    } catch {
      authUser = null
    }
    const cached = await db.getMeta<CachedUser>('user')
    if (authUser) {
      if (cached && cached.auth_key === authUser.id) {
        user.value = cached.user
        void refreshUser().catch(() => {})
      } else {
        await refreshUser()
      }
    }
    auth.onChange?.(() => void refreshUser().then(() => getEngine().syncNow()).catch(() => {}))

    initialized.value = true
    readyResolve()
    getEngine().start().catch((e) => console.error('StepTrack sync engine failed to start', e))
  }

  function init(): Promise<void> {
    if (!initPromise) {
      initPromise = doInit().catch((e) => {
        // still release waiters (route guard) so the app can show an error instead of hanging
        initialized.value = true
        readyResolve()
        throw e
      })
    }
    return initPromise
  }

  async function login(): Promise<void> {
    await getStepTrackConfig().auth.login()
    await refreshUser()
    if (user.value) void getEngine().syncNow()
  }

  async function logout(): Promise<void> {
    // local events and the outbox stay: they belong to the device and still have to reach the server
    await getStepTrackConfig().auth.logout()
    await cacheUser('', null)
    user.value = null
    pinSigners.value = []
  }

  function hasRole(role: Role, u: User | null = user.value): boolean {
    return !!u?.roles.includes(role)
  }

  function pinLockedUntil(userId: Uuid): number {
    const f = pinFailures.get(userId)
    return f && f.until > Date.now() ? f.until : 0
  }

  async function verifyPin(userId: Uuid, pin: string): Promise<Signer | null> {
    if (pinLockedUntil(userId)) return null
    const registry = useRegistryStore()
    const u = registry.users.find((x) => x.id === userId) ?? (user.value?.id === userId ? user.value : null)
    if (!u || !u.pin_verifier) return null
    const ok = await verifyPinHash(pin, u.pin_verifier)
    if (!ok) {
      const f = pinFailures.get(userId) ?? { count: 0, until: 0 }
      f.count++
      if (f.count >= PIN_MAX_FAILURES) {
        f.until = Date.now() + PIN_LOCKOUT_MS
        f.count = 0
      }
      pinFailures.set(userId, f)
      return null
    }
    pinFailures.delete(userId)
    if (!pinSigners.value.some((p) => p.id === u.id)) pinSigners.value = [...pinSigners.value, u]
    return { user: u, auth_method: 'pin' }
  }

  async function setPin(pin: string): Promise<void> {
    if (!isValidPin(pin)) throw new Error('st.session.pin.invalidFormat')
    if (!online.value) throw new OfflineError()
    await api.setPin(pin)
    // the new verifier reaches this and other devices via pull
    await refreshUser()
    void getEngine().syncNow()
  }

  function defaultSigner(): Signer {
    if (!user.value) throw new Error('st.session.errors.notSignedIn')
    return { user: user.value, auth_method: 'oidc' }
  }

  return {
    user, deviceId, online, pinSigners, initialized, authExpired,
    init, ready: () => readyPromise, refreshUser, login, logout, hasRole, verifyPin, setPin, defaultSigner,
    pinLockedUntil, clearPinSigners: () => (pinSigners.value = []),
  }
})
