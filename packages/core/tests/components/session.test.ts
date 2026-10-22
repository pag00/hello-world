import { pbkdf2Sync, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { messages } from '../../src/i18n'
import PinDialog from '../../src/components/session/PinDialog.vue'
import BlobImage from '../../src/components/session/BlobImage.vue'
import SyncStatusBadge from '../../src/components/SyncStatusBadge.vue'
import { useBlobStore, useRegistryStore, useSessionStore, useSyncStore } from '../../src/stores'
import { getDb, syncState } from '../../src/sync/runtime'
import { USERS, setup, teardown } from '../helpers'

afterEach(async () => {
  document.body.innerHTML = ''
  await teardown()
})

function i18n() {
  return createI18n({ legacy: false, locale: 'en', messages: messages as never })
}

async function boot() {
  const env = await setup()
  const session = useSessionStore()
  await session.init()
  await useSyncStore().syncNow()
  return { ...env, session }
}

function verifier(pin: string) {
  const salt = randomBytes(16)
  return `pbkdf2-sha256$100000$${salt.toString('base64')}$${pbkdf2Sync(pin, salt, 100000, 32, 'sha256').toString('base64')}`
}

describe('PinDialog', () => {
  it('online: the signed-in user signs without a PIN', async () => {
    const { pinia } = await boot()
    const w = mount(PinDialog, { props: { open: true }, global: { plugins: [pinia, i18n()] }, attachTo: document.body })
    await flushPromises()
    const btn = document.querySelector<HTMLButtonElement>('[data-test="sign-as-me"]')!
    expect(btn.textContent).toContain(USERS.op!.name)
    btn.click()
    expect(w.emitted('signed')![0]![0]).toMatchObject({ auth_method: 'oidc', user: { id: USERS.op!.id } })
    w.unmount()
  })

  it('filters by role, excludes users, and signs another user with a PIN', async () => {
    const { pinia } = await boot()
    await getDb().users.bulkPut([{ ...USERS.insp!, pin_verifier: verifier('112233') }, { ...USERS.sup!, pin_verifier: null }])
    await useRegistryStore().hydrate()
    syncState.online.value = false
    const w = mount(PinDialog, {
      props: { open: true, role: 'inspector', excludeUserIds: [USERS.op!.id] },
      global: { plugins: [pinia, i18n()] }, attachTo: document.body,
    })
    await flushPromises()
    expect(document.querySelector('[data-test="sign-as-me"]')).toBeNull()
    expect(document.querySelector(`[data-test="user-${USERS.sup!.id}"]`)).toBeNull() // not an inspector
    document.querySelector<HTMLButtonElement>(`[data-test="user-${USERS.insp!.id}"]`)!.click()
    await flushPromises()

    for (const k of '999999') window.dispatchEvent(new KeyboardEvent('keydown', { key: k }))
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-test="pin-confirm"]')!.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Wrong PIN'))
    expect(w.emitted('signed')).toBeUndefined()

    for (const k of '112233') window.dispatchEvent(new KeyboardEvent('keydown', { key: k }))
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-test="pin-confirm"]')!.click()
    await vi.waitFor(() => expect(w.emitted('signed')).toBeDefined())
    expect(w.emitted('signed')![0]![0]).toMatchObject({ auth_method: 'pin', user: { id: USERS.insp!.id } })
    w.unmount()
  })
})

describe('SyncStatusBadge', () => {
  it('shows pending counts and syncs on tap', async () => {
    const { pinia } = await boot()
    const sync = useSyncStore()
    const spy = vi.spyOn(sync, 'syncNow').mockResolvedValue()
    syncState.pendingEvents.value = 3
    const w = mount(SyncStatusBadge, { global: { plugins: [pinia, i18n()], stubs: { RouterLink: true } } })
    expect(w.text()).toContain('3 records pending')
    await w.find('button').trigger('click')
    expect(spy).toHaveBeenCalled()
    syncState.online.value = false
    await flushPromises()
    expect(w.text()).toContain('Offline')
  })
})

describe('BlobImage', () => {
  it('renders a locally stored blob and a placeholder for unknown refs', async () => {
    const { pinia } = await boot()
    const ref = await useBlobStore().put(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
    expect(ref).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await getDb().blobs.get(ref.slice(7))).toMatchObject({ uploaded: 0, mime: 'image/png', size: 3 })
    const w = mount(BlobImage, { props: { refId: ref, alt: 'overview' }, global: { plugins: [pinia, i18n()] } })
    await flushPromises()
    expect(w.find('img').attributes('src')).toMatch(/^blob:/)
    await w.setProps({ refId: 'sha256:' + '0'.repeat(64) })
    await flushPromises()
    expect(w.find('img').exists()).toBe(false)
    expect(w.text()).toContain('Image not available offline')
  })

  it('downloads a missing blob when online and verifies its hash', async () => {
    const { pinia, server } = await boot()
    const bytes = new Uint8Array([7, 7, 7])
    const hex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
    server.blobs.set(hex, bytes)
    server.blobs.set('f'.repeat(64), bytes) // wrong content for its name
    const store = useBlobStore()
    expect(await store.url(`sha256:${hex}`)).toMatch(/^blob:/)
    expect(await getDb().blobs.get(hex)).toMatchObject({ uploaded: 1 })
    expect(await store.url(`sha256:${'f'.repeat(64)}`)).toBeNull()
    void pinia
  })
})
