import type { PlannerRegisteredMilestone } from '@shared/contracts/plan'

export type {
  FlatTaskPlan,
  PlannerRegisteredMilestone,
  PlannerRegisteredSlice,
  PlannerRegisteredTask,
  SavedJobPlan
} from '@shared/contracts/plan'

export interface PlannerRegisteredTaskContext {
  taskTitle: string
  content: string
}

export interface PlannerRegisteredPlan {
  milestones: PlannerRegisteredMilestone[]
}
