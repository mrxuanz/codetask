import type { SavedJobPlan } from '@codetask/contracts'

export function clearPlanConfirmedFlags(plan: SavedJobPlan): SavedJobPlan {
  return {
    ...plan,
    milestones: plan.milestones.map((milestone) => ({
      ...milestone,
      confirmed: undefined,
      slices: milestone.slices.map((slice) => ({
        ...slice,
        confirmed: undefined,
        tasks: slice.tasks.map((task) => ({ ...task, confirmed: undefined }))
      }))
    })),
    tasks: plan.tasks.map((task) => ({ ...task, confirmed: undefined }))
  }
}

export function buildPlanSummary(plan: SavedJobPlan): {
  milestones: number
  slices: number
  tasks: number
} {
  return {
    milestones: plan.milestones.length,
    slices: plan.milestones.reduce((count, milestone) => count + milestone.slices.length, 0),
    tasks: plan.tasks.length
  }
}

export function isPlanFullyConfirmed(plan: SavedJobPlan): boolean {
  if (!plan.tasks.length) return false
  for (const milestone of plan.milestones) {
    if (!milestone.confirmed) return false
    for (const slice of milestone.slices) {
      if (!slice.confirmed || slice.tasks.some((task) => !task.confirmed)) return false
    }
  }
  return plan.tasks.every((task) => task.confirmed)
}
