// OIDC Authorization Code + PKCE via oidc-client-ts (ARCHITECTURE §8).
// Offline-first: the tablet must open and record evidence without the IdP, so the last profile is kept
// and token expiry never signs the user out locally. API calls simply fail auth until renewal succeeds.
import { UserManager, WebStorageStateStore, type User as OidcUser } from 'oidc-client-ts'
import type { AuthProvider, AuthUser } from './types'
import type { Role } from '../domain/types'

export interface OidcAuthOptions {
  authority: string
  clientId: string
  redirectUri: string
  scope?: string
  postLogoutRedirectUri?: string
  silentRedirectUri?: string
  /** claim carrying roles in the ID token / userinfo (server: OIDC_ROLES_CLAIM) */
  rolesClaim?: string
}

const PROFILE_KEY = 'steptrack.oidc.profile'
const RETURN_KEY = 'steptrack.oidc.return'

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

export class OidcAuthProvider implements AuthProvider {
  readonly kind = 'oidc' as const
  readonly manager: UserManager
  private listeners = new Set<(u: AuthUser | null) => void>()

  constructor(private readonly opts: OidcAuthOptions) {
    this.manager = new UserManager({
      authority: opts.authority,
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
      post_logout_redirect_uri: opts.postLogoutRedirectUri,
      silent_redirect_uri: opts.silentRedirectUri ?? opts.redirectUri,
      response_type: 'code',
      scope: opts.scope ?? 'openid profile email',
      automaticSilentRenew: true,
      userStore: new WebStorageStateStore({ store: window.localStorage }),
    })
    this.manager.events.addUserLoaded((u) => {
      const au = this.toAuthUser(u)
      this.saveProfile(au)
      this.emit(au)
    })
    this.manager.events.addUserSignedOut(() => this.emit(null))
    // silent renew failing offline is expected; keep the profile and retry on the next call
    this.manager.events.addSilentRenewError(() => {})
  }

  private toAuthUser(u: OidcUser): AuthUser {
    const p = u.profile as Record<string, unknown>
    const claim = p[this.opts.rolesClaim ?? 'roles']
    const roles = (Array.isArray(claim) ? claim : []).filter((r): r is Role => typeof r === 'string')
    return {
      id: String(p.sub),
      name: String(p.name ?? p.preferred_username ?? p.email ?? p.sub),
      email: typeof p.email === 'string' ? p.email : null,
      roles,
    }
  }

  private saveProfile(u: AuthUser | null) {
    try {
      if (u) localStorage.setItem(PROFILE_KEY, JSON.stringify(u))
      else localStorage.removeItem(PROFILE_KEY)
    } catch {
      /* storage unavailable: offline start falls back to the oidc user store */
    }
  }

  private savedProfile(): AuthUser | null {
    try {
      const raw = localStorage.getItem(PROFILE_KEY)
      return raw ? (JSON.parse(raw) as AuthUser) : null
    } catch {
      return null
    }
  }

  async getAccessToken(): Promise<string | null> {
    let user = await this.manager.getUser()
    if (!user) return null
    if (user.expired && !isOffline()) {
      try {
        user = await this.manager.signinSilent()
      } catch {
        return null
      }
    }
    return user && !user.expired ? user.access_token : null
  }

  async getAuthorizationHeader(): Promise<string | null> {
    const t = await this.getAccessToken()
    return t ? `Bearer ${t}` : null
  }

  async getUser(): Promise<AuthUser | null> {
    const u = await this.manager.getUser()
    if (u) return this.toAuthUser(u)
    // the oidc store may have been cleared by a failed renew; the saved profile keeps offline use possible
    return this.savedProfile()
  }

  async login(returnTo?: string): Promise<void> {
    try {
      sessionStorage.setItem(RETURN_KEY, returnTo ?? window.location.pathname + window.location.search)
    } catch {
      /* ignore */
    }
    await this.manager.signinRedirect()
  }

  async handleCallback(): Promise<void> {
    await this.manager.signinRedirectCallback()
  }

  /** Path stored before the redirect, consumed once by the callback view. */
  consumeReturnPath(): string | null {
    try {
      const p = sessionStorage.getItem(RETURN_KEY)
      sessionStorage.removeItem(RETURN_KEY)
      return p
    } catch {
      return null
    }
  }

  async logout(): Promise<void> {
    this.saveProfile(null)
    if (isOffline()) {
      await this.manager.removeUser()
      this.emit(null)
      return
    }
    try {
      await this.manager.signoutRedirect()
    } catch {
      await this.manager.removeUser()
      this.emit(null)
    }
  }

  onChange(cb: (user: AuthUser | null) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(u: AuthUser | null) {
    for (const cb of this.listeners) cb(u)
  }
}
