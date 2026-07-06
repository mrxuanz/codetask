import type { SavedJobPlan } from '@shared/contracts/plan'

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
  const milestones = plan.milestones.length
  const slices = plan.milestones.reduce((n, m) => n + m.slices.length, 0)
  const tasks = plan.tasks.length
  return { milestones, slices, tasks }
}

export function isPlanFullyConfirmed(plan: SavedJobPlan): boolean {
  if (!plan.tasks.length) return false
  for (const milestone of plan.milestones) {
    if (!milestone.confirmed) return false
    for (const slice of milestone.slices) {
      if (!slice.confirmed) return false
      for (const task of slice.tasks) {
        if (!task.confirmed) return false
      }
    }
  }
  for (const task of plan.tasks) {
    if (!task.confirmed) return false
  }
  return true
}
