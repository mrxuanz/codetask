import type { PlannerRegisteredMilestone } from '../../shared/contracts/plan.ts'

export type {
  FlatTaskPlan,
  JobExecutionProfile,
  PlannerRegisteredMilestone,
  PlannerRegisteredSlice,
  PlannerRegisteredTask,
  SavedJobPlan
} from '../../shared/contracts/plan.ts'

export interface PlannerRegisteredTaskContext {
  taskTitle: string
  content: string
}

export interface PlannerRegisteredPlan {
  milestones: PlannerRegisteredMilestone[]
}
