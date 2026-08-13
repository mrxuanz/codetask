import { createI18n } from 'vue-i18n'
import en from './locales/en'
import ja from './locales/ja'
import zh from './locales/zh'

export type AppLocale = 'zh' | 'ja' | 'en'

const LOCALE_STORAGE_KEY = 'app-locale'

const messages = { zh, ja, en }

const HTML_LANG: Record<AppLocale, string> = {
  zh: 'zh-CN',
  ja: 'ja',
  en: 'en'
}

function applyHtmlLang(locale: AppLocale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = HTML_LANG[locale]
}

function detectLocale(): AppLocale {
  const stored =
    typeof localStorage === 'undefined' ? null : localStorage.getItem(LOCALE_STORAGE_KEY)
  if (stored === 'zh' || stored === 'ja' || stored === 'en') return stored

  const lang = typeof navigator === 'undefined' ? 'en' : navigator.language.toLowerCase()
  if (lang.startsWith('ja')) return 'ja'
  if (lang.startsWith('zh')) return 'zh'
  return 'en'
}

const initialLocale = detectLocale()
applyHtmlLang(initialLocale)

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: 'en',
  messages
})

export function setAppLocale(locale: AppLocale): void {
  i18n.global.locale.value = locale
  if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  applyHtmlLang(locale)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('codetask:locale-changed'))
  }
}

export function getAppLocale(): AppLocale {
  return i18n.global.locale.value as AppLocale
}
