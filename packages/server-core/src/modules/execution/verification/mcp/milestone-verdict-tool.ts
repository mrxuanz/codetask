import type { MilestoneVerdict, WorkKind } from '@codetask/contracts'

const MILESTONE_STATUSES = new Set(['passed', 'needs-repair', 'blocked', 'inconclusive'])
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

/** Validates MCP / tool_call payload into a canonical MilestoneVerdict. */
export function parseCompleteMilestoneVerification(
  args: unknown,
  options?: { milestoneId?: string }
): MilestoneVerdict {
  const raw =
    args && typeof args === 'object' ? (args as Record<string, unknown>) : ({} as Record<string, unknown>)

  const status = nonEmpty(raw.status)
  if (!status || !MILESTONE_STATUSES.has(status)) {
    throw new Error('status must be passed, needs-repair, blocked, or inconclusive')
  }
  const confidence = nonEmpty(raw.confidence)
  if (!confidence || !CONFIDENCES.has(confidence)) {
    throw new Error('confidence must be high, medium, or low')
  }
  const summary = nonEmpty(raw.summary)
  if (!summary) throw new Error('summary is required')

  const requirementTrace = Array.isArray(raw.requirementTrace)
    ? raw.requirementTrace.map((item, index) => {
        const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
        const claim = nonEmpty(row.claim) ?? nonEmpty(row.requirement)
        const traceStatus = nonEmpty(row.status)
        const evidenceRef =
          nonEmpty(row.evidenceRef) ??
          (Array.isArray(row.evidence) && typeof row.evidence[0] === 'string'
            ? row.evidence[0]
            : claim)
        if (!claim || !traceStatus || !evidenceRef) {
          throw new Error(`requirementTrace[${index}] requires claim/requirement, status, evidenceRef`)
        }
        return { claim, evidenceRef, status: traceStatus }
      })
    : []

  const sliceAssessments = Array.isArray(raw.sliceAssessments)
    ? raw.sliceAssessments.map((item, index) => {
        const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
        const sliceId = nonEmpty(row.sliceId)
        const assessmentStatus = nonEmpty(row.status)
        if (!sliceId || !assessmentStatus) {
          throw new Error(`sliceAssessments[${index}] requires sliceId and status`)
        }
        return {
          sliceId,
          status: assessmentStatus,
          summary: nonEmpty(row.summary) ?? nonEmpty(row.reason) ?? `Slice ${sliceId}: ${assessmentStatus}`
        }
      })
    : []

  const repairSource = Array.isArray(raw.repairTasks)
    ? raw.repairTasks
    : Array.isArray(raw.repairSuggestions)
      ? raw.repairSuggestions
      : []

  const repairTasks = repairSource.map((item, index) => {
    const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const kindRaw = nonEmpty(row.kind) ?? 'implementation-repair'
    const kind = (WORK_KINDS.has(kindRaw as WorkKind) ? kindRaw : 'implementation-repair') as WorkKind
    const title =
      nonEmpty(row.title) ??
      nonEmpty(row.instruction) ??
      nonEmpty(row.evidenceGap) ??
      `Repair ${index + 1}`
    const description =
      nonEmpty(row.description) ??
      nonEmpty(row.instruction) ??
      nonEmpty(row.evidenceGap) ??
      title
    const successCriteria = nonEmpty(row.successCriteria) ?? 'Repair completed'
    const targetSliceId = nonEmpty(row.targetSliceId) ?? undefined
    const targetWorkId = nonEmpty(row.targetWorkId) ?? nonEmpty(row.targetTaskId) ?? undefined
    if (!targetSliceId && !targetWorkId) {
      throw new Error(`repairTasks[${index}] must include targetSliceId or targetWorkId`)
    }
    if (options?.milestoneId) {
      const prefix = `${options.milestoneId.trim().toLowerCase()}-`
      if (targetSliceId && !targetSliceId.toLowerCase().startsWith(prefix)) {
        throw new Error(
          `repairTasks[${index}].targetSliceId ${targetSliceId} is outside milestone ${options.milestoneId}`
        )
      }
      if (targetWorkId && !targetWorkId.toLowerCase().startsWith(prefix)) {
        // Work ids may be opaque (work_*); only enforce prefix when shaped like mN-sN-tN
        if (/^m\d+-s\d+/i.test(targetWorkId) && !targetWorkId.toLowerCase().startsWith(prefix)) {
          throw new Error(
            `repairTasks[${index}].targetWorkId ${targetWorkId} is outside milestone ${options.milestoneId}`
          )
        }
      }
    }
    return {
      kind,
      title,
      description,
      successCriteria,
      ...(targetSliceId ? { targetSliceId } : {}),
      ...(targetWorkId ? { targetWorkId } : {})
    }
  })

  if (status === 'needs-repair' && repairTasks.length === 0) {
    throw new Error('needs-repair requires repairTasks')
  }

  return {
    status: status as MilestoneVerdict['status'],
    confidence: confidence as MilestoneVerdict['confidence'],
    summary,
    requirementTrace,
    sliceAssessments,
    repairTasks
  }
}

export function handleCompleteMilestoneVerification(input: {
  arguments: unknown
  milestoneId?: string
}): MilestoneVerdict {
  return parseCompleteMilestoneVerification(input.arguments, {
    milestoneId: input.milestoneId
  })
}
