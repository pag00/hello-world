import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useProceduresStore, useRunsStore, useSessionStore, useSyncStore } from '../../src/stores'
import { DevAuthProvider } from '../../src/auth/dev'
import { installAuthGuard } from '../../src/auth/guard'
import { installStepTrack } from '../../src/plugin'
import { apiRequest } from '../../src/api/client'
import { disposeRuntime, getDb, syncState } from '../../src/sync/runtime'
import { API, FakeServer, PROCEDURE, REVISION, USERS, setup, teardown } from '../helpers'

afterEach(teardown)

describe('session store', () => {
  it('generates a device id once and keeps it', async () => {
    const env = await setup()
    const s = useSessionStore()
    await s.init()
    const id = s.deviceId
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(id[14]).toBe('7')
    expect(await getDb().getMeta('device_id')).toBe(id)

    // new process (pinia) on the same database → same device id
    const name = getDb().name
    disposeRuntime()
    setActivePinia(createPinia())
    const { setStepTrackConfig } = await import('../../src/config')
    setStepTrackConfig(env.app, { apiBaseUrl: API, basePath: '/', auth: env.auth, dbName: name })
    const s2 = useSessionStore()
    await s2.init()
    expect(s2.deviceId).toBe(id)
  })

  it('loads /me online and caches it; starts offline from the cache without network', async () => {
    const env = await setup()
    const s = useSessionStore()
    await s.init()
    expect(s.user?.id).toBe(USERS.op!.id)
    expect(await getDb().getMeta('user')).toMatchObject({ auth_key: USERS.op!.id, user: { id: USERS.op!.id } })

    // restart fully offline: the user and local data are restored, nothing blocks
    const name = getDb().name
    disposeRuntime()
    env.server.online = false
    setActivePinia(createPinia())
    const { setStepTrackConfig } = await import('../../src/config')
    setStepTrackConfig(env.app, { apiBaseUrl: API, basePath: '/', auth: env.auth, dbName: name })
    const s2 = useSessionStore()
    await s2.init()
    expect(s2.user?.name).toBe(USERS.op!.name)
    expect(useProceduresStore().releasedRevision(PROCEDURE.id)?.id).toBe(REVISION.id)
    await useSyncStore().syncNow()
    expect(syncState.online.value).toBe(false)
  })

  it('a 401 on /me keeps working offline-style and flags authExpired', async () => {
    const env = await setup()
    env.server.me = null
    const s = useSessionStore()
    await s.init()
    expect(s.user?.id).toBe(USERS.op!.id) // derived from the auth provider
    expect(s.authExpired).toBe(true)
  })

  it('logout keeps queued events on the device', async () => {
    const env = await setup()
    const s = useSessionStore()
    await s.init()
    await useSyncStore().syncNow()
    env.server.online = false
    syncState.online.value = false
    await useRunsStore().startRun({ revisionId: REVISION.id, serial: 'SN-LO' })
    await s.logout()
    expect(s.user).toBeNull()
    expect(await getDb().outbox.count()).toBe(1)
    expect(await getDb().events.count()).toBe(1)
  })
})

describe('auth guard', () => {
  it('redirects st-* routes to st-login without a user; public and host routes pass', async () => {
    await setup({ user: null })
    const Dummy = defineComponent({ render: () => h('div') })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'host-home', component: Dummy },
        { path: '/st', name: 'st-home', component: Dummy },
        { path: '/st/login', name: 'st-login', component: Dummy, meta: { public: true } },
      ],
    })
    installAuthGuard(router)
    void useSessionStore().init()
    await router.push('/st')
    expect(router.currentRoute.value.name).toBe('st-login')
    expect(router.currentRoute.value.query.redirect).toBe('/st')
    await router.push('/')
    expect(router.currentRoute.value.name).toBe('host-home')
  })
})

describe('DevAuthProvider', () => {
  it('lists users, persists the choice, sends "Dev <id>", works offline from cache', async () => {
    localStorage.clear()
    const server = new FakeServer()
    server.handlers.push((c) => (c.path === '/auth/dev-users' ? new Response(JSON.stringify([USERS.sup]), { headers: { 'content-type': 'application/json' } }) : undefined))
    globalThis.fetch = server.fetch as typeof fetch
    const p = new DevAuthProvider({ apiBaseUrl: API + '/' })
    const changes: unknown[] = []
    p.onChange((u) => changes.push(u))
    expect(await p.getAuthorizationHeader()).toBeNull()
    const users = await p.listUsers()
    expect(users.map((u) => u.id)).toEqual([USERS.sup!.id])
    p.selectUser(users[0]!)
    expect(await p.getAuthorizationHeader()).toBe(`Dev ${USERS.sup!.id}`)

    const again = new DevAuthProvider({ apiBaseUrl: API })
    expect((await again.getUser())?.id).toBe(USERS.sup!.id)
    server.online = false
    expect((await again.listUsers()).map((u) => u.id)).toEqual([USERS.sup!.id])
    await p.logout()
    expect(await p.getUser()).toBeNull()
    expect(changes).toHaveLength(2)
  })
})

describe('installStepTrack', () => {
  it('registers routes, installs the guard and initializes the session', async () => {
    localStorage.clear()
    disposeRuntime()
    const server = new FakeServer()
    globalThis.fetch = server.fetch as typeof fetch
    const auth = new DevAuthProvider({ apiBaseUrl: API })
    auth.selectUser({ id: USERS.op!.id, name: USERS.op!.name, roles: USERS.op!.roles })
    const app = createApp({ render: () => null })
    const pinia = createPinia()
    app.use(pinia)
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    installStepTrack(app, { router, basePath: '/procedures', apiBaseUrl: API, auth, dbName: `st-plugin-${Date.now()}` })
    expect(router.hasRoute('st-run-step')).toBe(true)
    expect(router.resolve({ name: 'st-settings' }).path).toBe('/procedures/settings')
    const session = useSessionStore(pinia)
    await session.ready()
    expect(session.user?.id).toBe(USERS.op!.id)
    // API calls carry the dev header
    await apiRequest('GET', '/health')
    expect(server.calls.at(-1)!.headers.get('authorization')).toBe(`Dev ${USERS.op!.id}`)
    vi.restoreAllMocks()
  })
})
