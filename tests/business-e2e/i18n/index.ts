import { MESSAGES, type Lang, type MessageBag } from './messages'

let currentLang: Lang = 'en'

export function resolveLang(raw?: string | null): Lang {
  const v = String(raw ?? process.env.BUSINESS_E2E_LANG ?? 'en')
    .trim()
    .toLowerCase()
  if (v.startsWith('zh') || v.startsWith('cn')) return 'zh'
  if (v.startsWith('ja') || v.startsWith('jp')) return 'ja'
  return 'en'
}

export function setLang(lang: Lang | string): Lang {
  currentLang = resolveLang(lang)
  return currentLang
}

export function getLang(): Lang {
  return currentLang
}

export function messages(): MessageBag {
  return MESSAGES[currentLang] ?? MESSAGES.en
}

export function tPart(part: string): string {
  return messages().parts[part] ?? part
}

export function tCase(caseId: string): string {
  return messages().cases[caseId] ?? caseId
}

export function tStep(step: string): string {
  return messages().steps[step] ?? step
}

export function tBanner(): string {
  return messages().banner
}

export function tSupervisor(): string {
  return messages().supervisor
}

export function tSuccess(): string {
  return messages().success
}

export function tFailure(): string {
  return messages().failure
}

export type { Lang, MessageBag }
