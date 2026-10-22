import type { App } from 'vue'
import type { Router } from 'vue-router'
import { createI18n, type I18n } from 'vue-i18n'
import { setStepTrackConfig, type StepTrackConfig } from './config'
import { createStepTrackRoutes } from './routes'
import { messages, type Locale } from './i18n'
import './styles/base.css'

export interface InstallOptions extends StepTrackConfig {
  router: Router
  /** host's vue-i18n instance (composition mode). If omitted, StepTrack installs its own. */
  i18n?: I18n
  locale?: Locale
  /** name of an existing host route to nest under; otherwise routes are added at top level */
  parentRouteName?: string
}

/**
 * Install StepTrack into a Vue app. The host must have installed Pinia (app.use(createPinia())) before.
 *
 *   installStepTrack(app, { router, basePath: '/procedures', apiBaseUrl: '/api/steptrack', auth })
 */
export function installStepTrack(app: App, options: InstallOptions): void {
  const { router, i18n, locale, parentRouteName, ...config } = options
  setStepTrackConfig(app, config)

  if (i18n) {
    for (const [loc, msgs] of Object.entries(messages)) {
      i18n.global.mergeLocaleMessage(loc, msgs as never)
    }
  } else {
    app.use(createI18n({ legacy: false, locale: locale ?? guessLocale(), fallbackLocale: 'en', messages: messages as never }))
  }

  for (const route of createStepTrackRoutes(config.basePath)) {
    if (parentRouteName) router.addRoute(parentRouteName, route)
    else router.addRoute(route)
  }
}

function guessLocale(): Locale {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en'
}
