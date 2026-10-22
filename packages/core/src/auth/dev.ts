// Dev-mode auth (server AUTH_MODE=dev): pick a seeded user, send "Authorization: Dev <user-id>".
import type { AuthProvider, AuthUser } from './types'

export interface DevAuthOptions {
  apiBaseUrl: string
  /** localStorage key prefix; lets several instances coexist */
  storageKey?: string
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export class DevAuthProvider implements AuthProvider {
  readonly kind = 'dev' as const
  private readonly key: string
  private listeners = new Set<(u: AuthUser | null) => void>()

  constructor(private readonly opts: DevAuthOptions) {
    this.key = opts.storageKey ?? 'steptrack.dev-auth'
  }

  private read<T>(suffix: string): T | null {
    const raw = storage()?.getItem(`${this.key}.${suffix}`)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  private write(suffix: string, value: unknown) {
    const s = storage()
    if (!s) return
    if (value === null) s.removeItem(`${this.key}.${suffix}`)
    else s.setItem(`${this.key}.${suffix}`, JSON.stringify(value))
  }

  /** GET /auth/dev-users (unauthenticated). Falls back to the last fetched list when offline. */
  async listUsers(): Promise<AuthUser[]> {
    try {
      const res = await fetch(`${this.opts.apiBaseUrl.replace(/\/$/, '')}/auth/dev-users`)
      if (!res.ok) throw new Error(`dev-users: ${res.status}`)
      const users = (await res.json()) as AuthUser[]
      this.write('users', users)
      return users
    } catch (e) {
      const cached = this.read<AuthUser[]>('users')
      if (cached) return cached
      throw e
    }
  }

  selectUser(user: AuthUser): void {
    this.write('user', user)
    this.emit(user)
  }

  async getAccessToken(): Promise<string | null> {
    return this.read<AuthUser>('user')?.id ?? null
  }

  async getAuthorizationHeader(): Promise<string | null> {
    const id = await this.getAccessToken()
    return id ? `Dev ${id}` : null
  }

  async getUser(): Promise<AuthUser | null> {
    return this.read<AuthUser>('user')
  }

  /** Selection happens in LoginView's picker; nothing to redirect to. */
  async login(): Promise<void> {}

  async logout(): Promise<void> {
    this.write('user', null)
    this.emit(null)
  }

  onChange(cb: (user: AuthUser | null) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(u: AuthUser | null) {
    for (const cb of this.listeners) cb(u)
  }
}

export function isDevAuthProvider(p: unknown): p is DevAuthProvider {
  return !!p && typeof p === 'object' && (p as { kind?: string }).kind === 'dev' && typeof (p as DevAuthProvider).listUsers === 'function'
}
