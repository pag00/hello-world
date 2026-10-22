// Standalone StepTrack shell (PWA + Capacitor Android). The workspace webapp embeds the same library via
// installStepTrack(); this file is the reference integration.
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import { DevAuthProvider, OidcAuthProvider, installStepTrack, stepTrackMessages, type AuthProvider } from '@steptrack/core'
import App from './App.vue'
import { registerServiceWorker } from './pwa'

const env = import.meta.env
const apiBaseUrl = (env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '')
const authMode = env.VITE_AUTH_MODE || (env.DEV ? 'dev' : 'oidc')

class ConfigError extends Error {}

function createAuth(): AuthProvider {
  if (authMode === 'dev') return new DevAuthProvider({ apiBaseUrl })
  if (authMode !== 'oidc') throw new ConfigError(`VITE_AUTH_MODE="${authMode}"`)
  if (!env.VITE_OIDC_AUTHORITY || !env.VITE_OIDC_CLIENT_ID) throw new ConfigError('VITE_OIDC_AUTHORITY / VITE_OIDC_CLIENT_ID')
  return new OidcAuthProvider({
    authority: env.VITE_OIDC_AUTHORITY,
    clientId: env.VITE_OIDC_CLIENT_ID,
    redirectUri: `${window.location.origin}/auth/callback`,
    postLogoutRedirectUri: `${window.location.origin}/login`,
    ...(env.VITE_OIDC_SCOPE ? { scope: env.VITE_OIDC_SCOPE } : {}),
    ...(env.VITE_OIDC_ROLES_CLAIM ? { rolesClaim: env.VITE_OIDC_ROLES_CLAIM } : {}),
  })
}

/** A misconfigured build must say so instead of showing a blank page (vue-i18n is not up yet). */
function showConfigError(detail: string) {
  const de = navigator.language.toLowerCase().startsWith('de')
  const msgs = (de ? stepTrackMessages.de : stepTrackMessages.en) as unknown as { st: { device: { app: { configError: string } } } }
  const el = document.getElementById('app')
  if (!el) return
  const p = document.createElement('p')
  p.style.cssText = 'font: 1.1rem system-ui, sans-serif; padding: 24px; color: #b3261e'
  p.textContent = msgs.st.device.app.configError.replace('{detail}', detail)
  el.replaceChildren(p)
}

function start() {
  let auth: AuthProvider
  try {
    auth = createAuth()
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error('StepTrack configuration error:', e.message)
      showConfigError(e.message)
      return
    }
    throw e
  }

  const app = createApp(App)
  app.use(createPinia())
  const router = createRouter({ history: createWebHistory(env.BASE_URL), routes: [] })
  // routes and the auth guard must exist before the router performs its initial navigation (app.use)
  installStepTrack(app, { router, basePath: '/', apiBaseUrl, auth })
  router.addRoute({ path: '/:pathMatch(.*)*', redirect: { name: 'st-home' } })
  app.use(router)
  app.mount('#app')
  registerServiceWorker()
}

start()
