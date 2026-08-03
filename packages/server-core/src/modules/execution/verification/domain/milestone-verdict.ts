import type { MilestoneVerdict } from '@codetask/contracts'

export type { MilestoneVerdict }

/**
 * Rule-based stub for unit tests / explicit fallback only.
 * Production Milestone verification goes through AgentRuntime + MCP
 * (createVerifyMilestoneService → complete_milestone_verification).
 */
export function evaluateMilestoneVerdict(input: {
  sliceIds: string[]
  sliceVerificationStates: Map<string, string>
}): MilestoneVerdict {
  const { sliceIds, sliceVerificationStates } = input
  if (sliceIds.length === 0) {
    return {
      status: 'inconclusive',
      confidence: 'low',
      summary: 'No slices in milestone',
      requirementTrace: [],
      sliceAssessments: [],
      repairTasks: []
    }
  }

  const assessments = sliceIds.map((sliceId) => {
    const status = sliceVerificationStates.get(sliceId) ?? 'pending'
    return {
      sliceId,
      status,
      summary: `Slice ${sliceId}: ${status}`
    }
  })

  const missing = assessments.filter((a) => a.status === 'pending' || a.status === 'inconclusive')
  if (missing.length > 0) {
    return {
      status: 'inconclusive',
      confidence: 'medium',
      summary: `${missing.length} slice(s) missing durable progress-ok verdict`,
      requirementTrace: missing.map((a) => ({
        claim: a.sliceId,
        evidenceRef: a.sliceId,
        status: a.status
      })),
      sliceAssessments: assessments,
      repairTasks: []
    }
  }

  const blocked = assessments.filter((a) => a.status === 'blocked')
  if (blocked.length > 0) {
    return {
      status: 'blocked',
      confidence: 'high',
      summary: `${blocked.length} slice(s) blocked`,
      requirementTrace: blocked.map((a) => ({
        claim: a.sliceId,
        evidenceRef: a.sliceId,
        status: 'blocked'
      })),
      sliceAssessments: assessments,
      repairTasks: []
    }
  }

  const needsRepair = assessments.filter((a) => a.status === 'needs-repair')
  if (needsRepair.length > 0) {
    return {
      status: 'needs-repair',
      confidence: 'high',
      summary: `${needsRepair.length} slice(s) need repair`,
      requirementTrace: needsRepair.map((a) => ({
        claim: a.sliceId,
        evidenceRef: a.sliceId,
        status: 'needs-repair'
      })),
      sliceAssessments: assessments,
      repairTasks: needsRepair.map((a) => ({
        kind: 'implementation-repair' as const,
        title: `Repair slice ${a.sliceId}`,
        description: `Milestone requires slice ${a.sliceId} to reach progress-ok`,
        targetSliceId: a.sliceId,
        successCriteria: 'Slice verification progress-ok'
      }))
    }
  }

  if (assessments.every((a) => a.status === 'progress-ok')) {
    return {
      status: 'passed',
      confidence: 'high',
      summary: 'All slices passed',
      requirementTrace: assessments.map((a) => ({
        claim: a.sliceId,
        evidenceRef: a.sliceId,
        status: 'progress-ok'
      })),
      sliceAssessments: assessments,
      repairTasks: []
    }
  }

  return {
    status: 'inconclusive',
    confidence: 'medium',
    summary: 'Unable to classify milestone outcome',
    requirementTrace: [],
    sliceAssessments: assessments,
    repairTasks: []
  }
}
