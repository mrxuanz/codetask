/** Planner MCP outline types (coord-based before ExecutionTreeSnapshot ids). */

export interface PlannerRegisteredTask {
  title?: string | undefined
  description?: string | undefined
  taskKind: string
  abilityCode?: string | undefined
  referenceIds?: string[] | undefined
  referenceReason?: string | undefined
  dependsOnTaskRefs?: string[] | undefined
  requiredInputs?: string[] | undefined
  successCriteria?: string | undefined
  canRunInParallel?: boolean | undefined
}

export interface PlannerRegisteredSlice {
  title?: string | undefined
  description?: string | undefined
  successCriteria: string
  dependsOnSliceRefs?: string[] | undefined
  tasks: PlannerRegisteredTask[]
}

export interface PlannerRegisteredMilestone {
  title?: string | undefined
  description?: string | undefined
  successCriteria?: string | undefined
  slices: PlannerRegisteredSlice[]
}

export interface PlannerRegisteredPlan {
  milestones: PlannerRegisteredMilestone[]
}

export interface PlannerRegisteredTaskContext {
  taskTitle: string
  content: string
}
