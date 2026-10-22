// Messages are split per feature area (one owner per file) and merged under the "st" namespace:
// i18n/en/run.json { "run": { ... } } → t('st.run.…')
type Messages = Record<string, unknown>

const en = import.meta.glob<Messages>('./en/*.json', { eager: true, import: 'default' })
const de = import.meta.glob<Messages>('./de/*.json', { eager: true, import: 'default' })

function merge(files: Record<string, Messages>): Messages {
  return Object.values(files).reduce<Messages>((acc, m) => ({ ...acc, ...m }), {})
}

export const messages = {
  en: { st: merge(en) },
  de: { st: merge(de) },
} as const

export type Locale = keyof typeof messages
export const SUPPORTED_LOCALES: Locale[] = ['en', 'de']
