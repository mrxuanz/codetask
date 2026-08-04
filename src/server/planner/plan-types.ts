import type { PlannerRegisteredMilestone } from '@codetask/contracts'

export type {
  FlatTaskPlan,
  JobExecutionProfile,
  PlannerRegisteredMilestone,
  PlannerRegisteredSlice,
  PlannerRegisteredTask,
  SavedJobPlan
} from '@codetask/contracts'

export interface PlannerRegisteredTaskContext {
  taskTitle: string
  content: string
}

export interface PlannerRegisteredPlan {
  milestones: PlannerRegisteredMilestone[]
}
