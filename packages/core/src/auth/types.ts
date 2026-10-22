import type { Role, Uuid } from '../domain/types'

export interface AuthUser {
  id: Uuid
  name: string
  email?: string | null
  roles: Role[]
}

/**
 * Pluggable auth. Standalone app uses OidcAuthProvider (or DevAuthProvider in dev);
 * the workspace webapp passes its own implementation to installStepTrack().
 */
export interface AuthProvider {
  /** Current access token for the API, or null when signed out. May refresh silently. */
  getAccessToken(): Promise<string | null>
  /** Value for the Authorization header ("Bearer <t>" or "Dev <user-id>"). */
  getAuthorizationHeader(): Promise<string | null>
  getUser(): Promise<AuthUser | null>
  login(): Promise<void>
  logout(): Promise<void>
  /** Called by the app after an OIDC redirect lands on the callback route. */
  handleCallback?(): Promise<void>
  onChange?(cb: (user: AuthUser | null) => void): () => void
}
