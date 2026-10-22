import type { App } from 'vue'
import type { Router } from 'vue-router'
import { getActivePinia, type Pinia } from 'pinia'
import { createI18n, type I18n } from 'vue-i18n'
import { setStepTrackConfig, type StepTrackConfig } from './config'
import { createStepTrackRoutes } from './routes'
import { messages, type Locale } from './i18n'
import { installAuthGuard } from './auth/guard'
import { useSessionStore } from './stores/session'
import './styles/base.css'

export interface InstallOptions extends StepTrackConfig {
  router: Router
  /** host's vue-i18n instance (composition mode). If omitted, StepTrack installs its own. */
  i18n?: I18n
  locale?: Locale
  /** name of an existing host route to nest under; otherwise routes are added at top level */
  parentRouteName?: string
  /** redirect st-* routes to st-login when signed out (default true) */
  authGuard?: boolean
  /** restore the local session and start syncing right away (default true) */
  autoInit?: boolean
}

const LOCALE_KEY = 'steptrack.locale'

/**
 * Install StepTrack into a Vue app. The host must have installed Pinia (app.use(createPinia())) before.
 *
 *   installStepTrack(app, { router, basePath: '/procedures', apiBaseUrl: '/api/steptrack', auth })
 */
export function installStepTrack(app: App, options: InstallOptions): void {
  const { router, i18n, locale, parentRouteName, authGuard = true, autoInit = true, ...config } = options
  setStepTrackConfig(app, config)

  if (i18n) {
    for (const [loc, msgs] of Object.entries(messages)) {
      i18n.global.mergeLocaleMessage(loc, msgs as never)
    }
  } else {
    app.use(createI18n({ legacy: false, locale: locale ?? savedLocale() ?? guessLocale(), fallbackLocale: 'en', messages: messages as never }))
  }

  for (const route of createStepTrackRoutes(config.basePath)) {
    if (parentRouteName) router.addRoute(parentRouteName, route)
    else router.addRoute(route)
  }

  const pinia = (app.config.globalProperties as { $pinia?: Pinia }).$pinia ?? getActivePinia()
  if (!pinia) throw new Error('StepTrack: install Pinia (app.use(createPinia())) before installStepTrack')
  if (authGuard) installAuthGuard(router, pinia)
  if (autoInit) {
    useSessionStore(pinia).init().catch((e) => console.error('StepTrack init failed', e))
  }
}

function savedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_KEY)
    return v === 'en' || v === 'de' ? v : null
  } catch {
    return null
  }
}

/** Persist the language chosen in settings (standalone app; an embedding host owns its own locale). */
export function saveLocale(loc: Locale): void {
  try {
    localStorage.setItem(LOCALE_KEY, loc)
  } catch {
    /* ignore */
  }
}

function guessLocale(): Locale {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en'
}
