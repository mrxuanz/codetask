/** Live progress lines for business e2e (stdout, flushed). Locale via i18n (--lang). */

import {
  labelForStep,
  resolveInternalCaseId,
  scopeLabelForCaseId,
  slugForCaseId,
  CASE_SLUG_BY_ID
} from '../cases/selection'
import { tBanner, tSupervisor } from '../i18n'

export function progress(scope: string, step: string, detail?: unknown): void {
  const scopeLabel = humanizeScope(scope)
  const stepLabel = labelForStep(step)
  const suffix =
    detail === undefined
      ? ''
      : typeof detail === 'string'
        ? ` ${detail}`
        : ` ${compactDetail(detail)}`
  const line = `[${tBanner()}][${localStamp()}] ${scopeLabel} · ${stepLabel}${suffix}`
  process.stdout.write(`${line}\n`)
}

/** Local wall clock for live logs, e.g. `0723-21.13`. */
export function localStamp(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  return `${mm}${dd}-${hh}.${mi}`
}

function humanizeScope(scope: string): string {
  if (scope === 'supervisor') return tSupervisor()
  if (/[\u4e00-\u9fff]/.test(scope)) return scope

  // Already an internal catalog id
  if (/^(G\d|FOUNDATION|DRAFT|CHAT|SETTINGS|JOB)/i.test(scope)) {
    return scopeLabelForCaseId(scope)
  }

  // Friendly slug (notes-search) or unknown → resolve then label
  const asId = resolveInternalCaseId(scope)
  if (CASE_SLUG_BY_ID[asId] || asId !== scope) {
    return scopeLabelForCaseId(asId)
  }

  // Slug that maps from id side
  const fromSlug = Object.entries(CASE_SLUG_BY_ID).find(([, slug]) => slug === scope)?.[0]
  if (fromSlug) return scopeLabelForCaseId(fromSlug)

  return slugForCaseId(scope)
}

function compactDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return ''
  if (typeof detail !== 'object') return String(detail)
  try {
    const text = JSON.stringify(detail)
    return text.length > 220 ? `${text.slice(0, 220)}…` : text
  } catch {
    return String(detail)
  }
}
