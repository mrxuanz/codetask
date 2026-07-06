import { getAppLocale, type AppLocale } from '@renderer/i18n'

const LOCALE_BCP47: Record<AppLocale, string> = {
  zh: 'zh-CN',
  ja: 'ja',
  en: 'en'
}

function resolveLocale(locale?: AppLocale): string {
  return LOCALE_BCP47[locale ?? getAppLocale()]
}

function toDate(value: string | number | Date): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed)
}

export function formatUnixTimestamp(sec: number, locale?: AppLocale): string {
  if (!sec) return ''
  return formatDateTimeValue(sec * 1000, locale)
}

export function formatDateTimeValue(
  value: string | number | Date | null | undefined,
  locale?: AppLocale
): string {
  if (value == null || value === '') return ''
  const date = toDate(value)
  if (!date) return typeof value === 'string' ? value : ''
  return new Intl.DateTimeFormat(resolveLocale(locale), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date)
}
