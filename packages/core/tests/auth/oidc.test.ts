import { afterEach, describe, expect, it, vi } from 'vitest'
import { User } from 'oidc-client-ts'
import { OidcAuthProvider } from '../../src/auth/oidc'

function provider() {
  return new OidcAuthProvider({ authority: 'https://idp.test/realms/x', clientId: 'steptrack', redirectUri: 'https://app.test/auth/callback', rolesClaim: 'st_roles' })
}

function oidcUser(expiresInS: number) {
  return new User({
    access_token: 'at-123', token_type: 'Bearer', scope: 'openid', id_token: 'x',
    profile: { sub: 'sub-1', iss: 'https://idp.test/realms/x', aud: 'steptrack', exp: 0, iat: 0, name: 'Olga', email: 'o@x', st_roles: ['operator', 42] } as never,
    expires_at: Math.floor(Date.now() / 1000) + expiresInS,
  })
}

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('OidcAuthProvider', () => {
  it('maps the profile and roles claim; bearer header while valid', async () => {
    const p = provider()
    await p.manager.storeUser(oidcUser(3600))
    expect(await p.getUser()).toEqual({ id: 'sub-1', name: 'Olga', email: 'o@x', roles: ['operator'] })
    expect(await p.getAuthorizationHeader()).toBe('Bearer at-123')
  })

  it('offline with an expired token: no token, but the profile stays so the app opens', async () => {
    const p = provider()
    await p.manager.storeUser(oidcUser(-60))
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const silent = vi.spyOn(p.manager, 'signinSilent')
    expect(await p.getAccessToken()).toBeNull()
    expect(silent).not.toHaveBeenCalled()
    expect((await p.getUser())?.id).toBe('sub-1')
  })

  it('online with an expired token tries a silent renew', async () => {
    const p = provider()
    await p.manager.storeUser(oidcUser(-60))
    const renewed = oidcUser(3600)
    vi.spyOn(p.manager, 'signinSilent').mockResolvedValue(renewed)
    expect(await p.getAccessToken()).toBe('at-123')
  })

  it('keeps the last profile when the oidc store was cleared; logout forgets it', async () => {
    const p = provider()
    await p.manager.storeUser(oidcUser(3600))
    // userLoaded is raised by sign-in flows; simulate it to record the backup profile
    await (p.manager.events as unknown as { load(u: User): Promise<void> }).load(oidcUser(3600))
    await p.manager.removeUser()
    expect((await p.getUser())?.id).toBe('sub-1')
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await p.logout()
    expect(await p.getUser()).toBeNull()
  })
})
