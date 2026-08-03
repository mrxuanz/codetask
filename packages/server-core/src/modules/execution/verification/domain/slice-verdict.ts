import type { SliceVerdict, WorkState } from '@codetask/contracts'
import type { WorkItemRecord } from '../../work/domain/work-item.ts'
import { isWorkDone, isWorkTerminal } from '../../work/domain/work-item.ts'

export type { SliceVerdict }

/** Bundle identity for a slice: generation + ordered work id/state pairs. */
export function sliceEvidenceBundleHashInput(
  jobId: string,
  sliceId: string,
  generation: number,
  workItems: WorkItemRecord[]
): string {
  const parts = workItems
    .filter((w) => w.sliceId === sliceId && w.generation === generation)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .map((w) => `${w.id}:${w.state}:${w.kind}`)
  return `${jobId}:${sliceId}:${generation}:${parts.join('|')}`
}

/**
 * Rule-based stub for unit tests / explicit fallback only.
 * Production Slice verification goes through AgentRuntime + MCP
 * (createVerifySliceService → complete_slice_verification).
 */
export function evaluateSliceVerdict(workItems: WorkItemRecord[]): SliceVerdict {
  if (workItems.length === 0) {
    return {
      status: 'inconclusive',
      confidence: 'low',
      summary: 'No work items in slice',
      satisfiedSignals: [],
      missingSignals: ['no-work'],
      questionableClaims: [],
      evidenceTrace: [],
      repairSuggestions: []
    }
  }

  if (!workItems.every((w) => isWorkTerminal(w.state))) {
    return {
      status: 'inconclusive',
      confidence: 'low',
      summary: 'Slice work is not terminal',
      satisfiedSignals: [],
      missingSignals: workItems.filter((w) => !isWorkTerminal(w.state)).map((w) => w.id),
      questionableClaims: [],
      evidenceTrace: [],
      repairSuggestions: []
    }
  }

  const blocked = workItems.filter((w) => w.state === 'blocked')
  if (blocked.length > 0) {
    return {
      status: 'blocked',
      confidence: 'high',
      summary: `${blocked.length} work item(s) blocked`,
      satisfiedSignals: workItems.filter((w) => isWorkDone(w.state)).map((w) => w.id),
      missingSignals: blocked.map((w) => w.id),
      questionableClaims: [],
      evidenceTrace: blocked.map((w) => ({
        claim: w.title,
        evidenceRef: w.id,
        status: 'blocked'
      })),
      repairSuggestions: []
    }
  }

  const failed = workItems.filter(
    (w) =>
      (w.state === 'failed' || w.state === 'cancelled') &&
      w.kind === 'task'
  )
  if (failed.length > 0) {
    return {
      status: 'needs-repair',
      confidence: 'high',
      summary: `${failed.length} work item(s) need repair`,
      satisfiedSignals: workItems.filter((w) => isWorkDone(w.state)).map((w) => w.id),
      missingSignals: failed.map((w) => w.id),
      questionableClaims: [],
      evidenceTrace: failed.map((w) => ({
        claim: w.title,
        evidenceRef: w.id,
        status: w.state
      })),
      repairSuggestions: failed.map((w) => ({
        kind: 'implementation-repair' as const,
        title: `Repair: ${w.title}`,
        description: `Repair failed work ${w.id}`,
        targetWorkId: w.id,
        targetSliceId: w.sliceId,
        successCriteria: w.successCriteria || 'Repair completed'
      }))
    }
  }

  const failedRepair = workItems.filter(
    (w) =>
      (w.state === 'failed' || w.state === 'cancelled') &&
      w.kind !== 'task'
  )
  if (failedRepair.length > 0) {
    return {
      status: 'blocked',
      confidence: 'high',
      summary: `${failedRepair.length} repair work item(s) failed`,
      satisfiedSignals: workItems.filter((w) => isWorkDone(w.state)).map((w) => w.id),
      missingSignals: failedRepair.map((w) => w.id),
      questionableClaims: [],
      evidenceTrace: failedRepair.map((w) => ({
        claim: w.title,
        evidenceRef: w.id,
        status: w.state
      })),
      repairSuggestions: []
    }
  }

  if (workItems.every((w) => isWorkDone(w.state))) {
    return {
      status: 'progress-ok',
      confidence: 'high',
      summary: 'All work succeeded',
      satisfiedSignals: ['all-work-succeeded'],
      missingSignals: [],
      questionableClaims: [],
      evidenceTrace: workItems.map((w) => ({
        claim: w.title,
        evidenceRef: w.id,
        status: w.state as WorkState
      })),
      repairSuggestions: []
    }
  }

  return {
    status: 'inconclusive',
    confidence: 'medium',
    summary: 'Unable to classify slice outcome',
    satisfiedSignals: [],
    missingSignals: workItems.map((w) => w.id),
    questionableClaims: [],
    evidenceTrace: [],
    repairSuggestions: []
  }
}
