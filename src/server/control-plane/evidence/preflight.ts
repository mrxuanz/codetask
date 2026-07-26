import type { SavedJobPlan } from '../../planner/plan-types'
import type { TaskProgressItemDto } from '../types'

function sliceTaskIds(plan: SavedJobPlan, sliceId: string): string[] {
  const match = /^m(\d+)-s(\d+)$/.exec(sliceId)
  if (!match) return []
  const m = Number(match[1])
  const s = Number(match[2])
  return plan.tasks
    .filter((task) => task.milestoneIndex === m && task.sliceIndex === s)
    .map((task) => task.id)
}

export interface EvidencePreflightResult {
  ok: boolean
  missingTaskIds: string[]
  missingSliceIds?: string[]
}

export function preflightSliceTaskEvidence(
  plan: SavedJobPlan,
  sliceId: string,
  taskItems: TaskProgressItemDto[]
): EvidencePreflightResult {
  const taskIds = sliceTaskIds(plan, sliceId)
  const missingTaskIds: string[] = []

  for (const taskId of taskIds) {
    const item = taskItems.find((row) => row.id === taskId)
    if (!item) {
      missingTaskIds.push(taskId)
      continue
    }
    if (item.status !== 'completed' && item.status !== 'skipped') continue
    if (!item.evidence) {
      missingTaskIds.push(taskId)
    }
  }

  if (missingTaskIds.length === 0) {
    return { ok: true, missingTaskIds: [] }
  }

  return {
    ok: false,
    missingTaskIds
  }
}

export function preflightMilestoneSliceVerdicts(
  milestoneSliceIds: string[],
  sliceVerdicts: Record<string, unknown>
): EvidencePreflightResult {
  const missingSliceIds = milestoneSliceIds.filter((sliceId) => !sliceVerdicts[sliceId])
  if (missingSliceIds.length === 0) {
    return { ok: true, missingTaskIds: [] }
  }
  return {
    ok: false,
    missingTaskIds: [],
    missingSliceIds
  }
}
