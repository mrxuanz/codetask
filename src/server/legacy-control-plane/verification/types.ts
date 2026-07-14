export interface SliceVerificationVerdict {
  status: 'progress-ok' | 'needs-repair' | 'blocked' | 'inconclusive'
  confidence: 'high' | 'medium' | 'low'
  summary: string
  satisfiedSignals: string[]
  missingSignals: string[]
  questionableClaims: string[]
  evidenceTrace: Array<{
    requirement: string
    status: string
    evidence?: string[] | undefined
  }>
  repairSuggestions: Array<{
    reason: string
    instruction: string
    targetTaskId?: string | undefined
  }>
}

export interface MilestoneVerificationVerdict {
  status: 'passed' | 'needs-repair' | 'blocked' | 'inconclusive'
  confidence: 'high' | 'medium' | 'low'
  summary: string
  requirementTrace: Array<{
    requirement: string
    status: string
    evidence?: string[] | undefined
  }>
  sliceAssessments: Array<{
    sliceId: string
    status: string
    reason: string
  }>
  repairTasks: Array<{
    instruction: string
    evidenceGap: string
    targetSliceId?: string | undefined
    targetTaskId?: string | undefined
  }>
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseMilestoneRepairTarget(
  row: Record<string, unknown>,
  index: number
): {
  instruction: string
  evidenceGap: string
  targetSliceId?: string | undefined
  targetTaskId?: string | undefined
} {
  const instruction = nonEmpty(row.instruction)
  const evidenceGap = nonEmpty(row.evidenceGap)
  if (!instruction || !evidenceGap) {
    throw new Error(`repairTasks[${index}] need instruction and evidenceGap`)
  }

  const targetSliceId = nonEmpty(row.targetSliceId) ?? undefined
  const targetTaskId = nonEmpty(row.targetTaskId) ?? undefined
  if (!targetSliceId && !targetTaskId) {
    throw new Error(
      `repairTasks[${index}] must include targetSliceId (e.g. m1-s2) or targetTaskId (e.g. m1-s2-t1)`
    )
  }
  if (targetSliceId && !/^m\d+-s\d+$/i.test(targetSliceId)) {
    throw new Error(
      `repairTasks[${index}].targetSliceId must match m{N}-s{N} (got ${targetSliceId})`
    )
  }
  if (targetTaskId && !/^m\d+-s\d+-t\d+$/i.test(targetTaskId)) {
    throw new Error(
      `repairTasks[${index}].targetTaskId must match m{N}-s{N}-t{N} (got ${targetTaskId})`
    )
  }

  return { instruction, evidenceGap, targetSliceId, targetTaskId }
}

function assertRepairTargetsInMilestone(
  repairTasks: MilestoneVerificationVerdict['repairTasks'],
  milestoneId: string
): void {
  const milestonePrefix = `${milestoneId.trim().toLowerCase()}-`
  for (const [index, repair] of repairTasks.entries()) {
    if (repair.targetSliceId) {
      const sliceId = repair.targetSliceId.toLowerCase()
      if (!sliceId.startsWith(milestonePrefix)) {
        throw new Error(
          `repairTasks[${index}].targetSliceId ${repair.targetSliceId} is outside milestone ${milestoneId}`
        )
      }
    }
    if (repair.targetTaskId) {
      const taskId = repair.targetTaskId.toLowerCase()
      if (!taskId.startsWith(milestonePrefix)) {
        throw new Error(
          `repairTasks[${index}].targetTaskId ${repair.targetTaskId} is outside milestone ${milestoneId}`
        )
      }
    }
  }
}

export function normalizeSliceVerificationVerdict(
  raw: Record<string, unknown>
): SliceVerificationVerdict {
  const status = nonEmpty(raw.status)
  if (!status || !['progress-ok', 'needs-repair', 'blocked', 'inconclusive'].includes(status)) {
    throw new Error('status must be progress-ok, needs-repair, blocked, or inconclusive')
  }
  const confidence = nonEmpty(raw.confidence)
  if (!confidence || !['high', 'medium', 'low'].includes(confidence)) {
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
        const requirement = nonEmpty(row.requirement)
        const traceStatus = nonEmpty(row.status)
        if (!requirement || !traceStatus) {
          throw new Error(`evidenceTrace[${index}] requires requirement and status`)
        }
        return {
          requirement,
          status: traceStatus,
          evidence: Array.isArray(row.evidence)
            ? row.evidence.filter((v): v is string => typeof v === 'string')
            : undefined
        }
      })
    : []

  const repairSuggestions = Array.isArray(raw.repairSuggestions)
    ? raw.repairSuggestions.map((item) => {
        const row = item as Record<string, unknown>
        const reason = nonEmpty(row.reason)
        const instruction = nonEmpty(row.instruction)
        if (!reason || !instruction)
          throw new Error('repairSuggestions need reason and instruction')
        return {
          reason,
          instruction,
          targetTaskId: nonEmpty(row.targetTaskId) ?? undefined
        }
      })
    : []

  if (status === 'needs-repair' && repairSuggestions.length === 0) {
    throw new Error('needs-repair requires repairSuggestions')
  }

  return {
    status: status as SliceVerificationVerdict['status'],
    confidence: confidence as SliceVerificationVerdict['confidence'],
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

export function normalizeMilestoneVerificationVerdict(
  raw: Record<string, unknown>,
  options?: { milestoneId?: string }
): MilestoneVerificationVerdict {
  const status = nonEmpty(raw.status)
  if (!status || !['passed', 'needs-repair', 'blocked', 'inconclusive'].includes(status)) {
    throw new Error('status must be passed, needs-repair, blocked, or inconclusive')
  }
  const confidence = nonEmpty(raw.confidence)
  if (!confidence || !['high', 'medium', 'low'].includes(confidence)) {
    throw new Error('confidence must be high, medium, or low')
  }
  const summary = nonEmpty(raw.summary)
  if (!summary) throw new Error('summary is required')

  const requirementTrace = Array.isArray(raw.requirementTrace)
    ? raw.requirementTrace.map((item) => {
        const row = item as Record<string, unknown>
        const requirement = nonEmpty(row.requirement)
        const traceStatus = nonEmpty(row.status)
        if (!requirement || !traceStatus)
          throw new Error('requirementTrace items need requirement and status')
        return {
          requirement,
          status: traceStatus,
          evidence: Array.isArray(row.evidence)
            ? row.evidence.filter((v): v is string => typeof v === 'string')
            : undefined
        }
      })
    : []

  const sliceAssessments = Array.isArray(raw.sliceAssessments)
    ? raw.sliceAssessments.map((item) => {
        const row = item as Record<string, unknown>
        const sliceId = nonEmpty(row.sliceId)
        const assessStatus = nonEmpty(row.status)
        const reason = nonEmpty(row.reason) ?? ''
        if (!sliceId || !assessStatus) throw new Error('sliceAssessments need sliceId and status')
        return { sliceId, status: assessStatus, reason }
      })
    : []

  const repairTasks = Array.isArray(raw.repairTasks)
    ? raw.repairTasks.map((item, index) => {
        if (!item || typeof item !== 'object') {
          throw new Error(`repairTasks[${index}] must be an object`)
        }
        return parseMilestoneRepairTarget(item as Record<string, unknown>, index)
      })
    : []

  if (status === 'needs-repair' && repairTasks.length === 0) {
    throw new Error(
      'needs-repair requires at least one repairTasks item with a targetSliceId or targetTaskId'
    )
  }

  const milestoneId = options?.milestoneId?.trim()
  if (milestoneId && repairTasks.length > 0) {
    assertRepairTargetsInMilestone(repairTasks, milestoneId)
  }

  return {
    status: status as MilestoneVerificationVerdict['status'],
    confidence: confidence as MilestoneVerificationVerdict['confidence'],
    summary,
    requirementTrace,
    sliceAssessments,
    repairTasks
  }
}
