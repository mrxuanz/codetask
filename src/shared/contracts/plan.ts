export interface PlannerRegisteredTask {
  title?: string
  description?: string
  taskKind: string
  abilityCode?: string
  referenceIds?: string[]
  referenceReason?: string
  dependsOnTaskRefs?: string[]
  requiredInputs?: string[]
  successCriteria?: string
  canRunInParallel?: boolean
  confirmed?: boolean
}

export interface PlannerRegisteredSlice {
  title?: string
  description?: string
  successCriteria: string
  dependsOnSliceRefs?: string[]
  confirmed?: boolean
  tasks: PlannerRegisteredTask[]
}

export interface PlannerRegisteredMilestone {
  title?: string
  description?: string
  successCriteria?: string
  confirmed?: boolean
  slices: PlannerRegisteredSlice[]
}

export interface FlatTaskPlan {
  id: string
  milestoneIndex: number
  sliceIndex: number
  taskIndex: number
  title: string
  description: string
  taskKind: string
  abilityCode: string
  contextMarkdown: string
  coreCode?: string
  successCriteria: string
  referenceIds?: string[]
  referenceReason?: string
  dependsOnTaskRefs?: string[]
  canRunInParallel?: boolean
  confirmed?: boolean
}

export interface SavedJobPlan {
  milestones: PlannerRegisteredMilestone[]
  tasks: FlatTaskPlan[]
}
