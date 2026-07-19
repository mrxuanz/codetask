/** Live progress lines for business e2e (stdout, flushed). Chinese labels for now. */

import {
  labelForStep,
  resolveInternalCaseId,
  scopeLabelForCaseId,
  slugForCaseId,
  CASE_SLUG_BY_ID
} from '../cases/selection'

export function progress(scope: string, step: string, detail?: unknown): void {
  const scopeLabel = humanizeScope(scope)
  const stepLabel = labelForStep(step)
  const suffix =
    detail === undefined
      ? ''
      : typeof detail === 'string'
        ? ` ${detail}`
        : ` ${compactDetail(detail)}`
  const line = `[业务测试] ${scopeLabel} · ${stepLabel}${suffix}`
  process.stdout.write(`${line}\n`)
}

function humanizeScope(scope: string): string {
  if (scope === 'supervisor') return '调度器'
  if (/[\u4e00-\u9fff]/.test(scope)) return scope

  // Already an internal catalog id
  if (/^(G\d|FOUNDATION|DRAFT)/i.test(scope)) {
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
