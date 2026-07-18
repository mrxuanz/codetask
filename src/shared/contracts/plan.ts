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
  confirmed?: boolean | undefined
}

export interface PlannerRegisteredSlice {
  title?: string | undefined
  description?: string | undefined
  successCriteria: string
  dependsOnSliceRefs?: string[] | undefined
  confirmed?: boolean | undefined
  tasks: PlannerRegisteredTask[]
}

export interface PlannerRegisteredMilestone {
  title?: string | undefined
  description?: string | undefined
  successCriteria?: string | undefined
  confirmed?: boolean | undefined
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
  coreCode?: string | undefined
  successCriteria: string
  referenceIds?: string[] | undefined
  referenceReason?: string | undefined
  dependsOnTaskRefs?: string[] | undefined
  canRunInParallel?: boolean | undefined
  confirmed?: boolean | undefined
}

export interface SavedJobPlan {
  milestones: PlannerRegisteredMilestone[]
  tasks: FlatTaskPlan[]
}
