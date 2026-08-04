import type { SliceVerdict, WorkKind } from '@codetask/contracts'

const SLICE_STATUSES = new Set(['progress-ok', 'needs-repair', 'blocked', 'inconclusive'])
const CONFIDENCES = new Set(['high', 'medium', 'low'])
const WORK_KINDS = new Set<WorkKind>([
  'task',
  'preparation-repair',
  'implementation-repair',
  'evidence-repair'
])

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Validates MCP / tool_call payload into a canonical SliceVerdict. */
export function parseCompleteSliceVerification(args: unknown): SliceVerdict {
  const raw =
    args && typeof args === 'object'
      ? (args as Record<string, unknown>)
      : ({} as Record<string, unknown>)

  const status = nonEmpty(raw.status)
  if (!status || !SLICE_STATUSES.has(status)) {
    throw new Error('status must be progress-ok, needs-repair, blocked, or inconclusive')
  }
  const confidence = nonEmpty(raw.confidence)
  if (!confidence || !CONFIDENCES.has(confidence)) {
    throw new Error('confidence must be high, medium, or low')
  }
  const summary = nonEmpty(raw.summary)
  if (!summary) throw new Error('summary is required')

  const evidenceTrace = Array.isArray(raw.evidenceTrace)
    ? raw.evidenceTrace.map((item, index) => {
        if (!item || typeof item !== 'object') {
          throw new Error(`evidenceTrace[${index}] must be an object`)
        }
        const row = item as Record<string, unknown>
        const claim = nonEmpty(row.claim) ?? nonEmpty(row.requirement)
        const traceStatus = nonEmpty(row.status)
        const evidenceRef =
          nonEmpty(row.evidenceRef) ??
          (Array.isArray(row.evidence) && typeof row.evidence[0] === 'string'
            ? row.evidence[0]
            : claim)
        if (!claim || !traceStatus || !evidenceRef) {
          throw new Error(`evidenceTrace[${index}] requires claim/requirement, status, evidenceRef`)
        }
        return { claim, evidenceRef, status: traceStatus }
      })
    : []

  const repairSuggestions = Array.isArray(raw.repairSuggestions)
    ? raw.repairSuggestions.map((item, index) => {
        const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
        const kindRaw = nonEmpty(row.kind) ?? 'implementation-repair'
        const kind = (
          WORK_KINDS.has(kindRaw as WorkKind) ? kindRaw : 'implementation-repair'
        ) as WorkKind
        const title =
          nonEmpty(row.title) ??
          nonEmpty(row.reason) ??
          nonEmpty(row.instruction) ??
          `Repair ${index + 1}`
        const description =
          nonEmpty(row.description) ?? nonEmpty(row.instruction) ?? nonEmpty(row.reason) ?? title
        const successCriteria = nonEmpty(row.successCriteria) ?? 'Repair completed'
        return {
          kind,
          title,
          description,
          successCriteria,
          ...(nonEmpty(row.targetWorkId) || nonEmpty(row.targetTaskId)
            ? { targetWorkId: (nonEmpty(row.targetWorkId) ?? nonEmpty(row.targetTaskId))! }
            : {}),
          ...(nonEmpty(row.targetSliceId) ? { targetSliceId: nonEmpty(row.targetSliceId)! } : {})
        }
      })
    : []

  if (status === 'needs-repair' && repairSuggestions.length === 0) {
    throw new Error('needs-repair requires repairSuggestions')
  }

  return {
    status: status as SliceVerdict['status'],
    confidence: confidence as SliceVerdict['confidence'],
    summary,
    satisfiedSignals: Array.isArray(raw.satisfiedSignals)
      ? raw.satisfiedSignals.filter((v): v is string => typeof v === 'string')
      : [],
    missingSignals: Array.isArray(raw.missingSignals)
      ? raw.missingSignals.filter((v): v is string => typeof v === 'string')
      : [],
    questionableClaims: Array.isArray(raw.questionableClaims)
      ? raw.questionableClaims.filter((v): v is string => typeof v === 'string')
      : [],
    evidenceTrace,
    repairSuggestions
  }
}

export function handleCompleteSliceVerification(input: { arguments: unknown }): SliceVerdict {
  return parseCompleteSliceVerification(input.arguments)
}
