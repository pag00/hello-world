/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** sync server base URL; default "/api" (same origin, proxied). Must be absolute for the Capacitor APK. */
  readonly VITE_API_BASE_URL?: string
  /** "dev" (seeded users, Authorization: Dev <id>) or "oidc"; default "dev" in `vite dev`, "oidc" in builds */
  readonly VITE_AUTH_MODE?: 'dev' | 'oidc'
  readonly VITE_OIDC_AUTHORITY?: string
  readonly VITE_OIDC_CLIENT_ID?: string
  readonly VITE_OIDC_SCOPE?: string
  /** claim holding roles (server: OIDC_ROLES_CLAIM) */
  readonly VITE_OIDC_ROLES_CLAIM?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
