import type { ProviderCode } from './execution.ts'

export type PlannerRegisteredTask = {
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

export type PlannerRegisteredSlice = {
  title?: string | undefined
  description?: string | undefined
  successCriteria: string
  dependsOnSliceRefs?: string[] | undefined
  confirmed?: boolean | undefined
  tasks: PlannerRegisteredTask[]
}

export type PlannerRegisteredMilestone = {
  title?: string | undefined
  description?: string | undefined
  successCriteria?: string | undefined
  confirmed?: boolean | undefined
  slices: PlannerRegisteredSlice[]
}

/** Flat task row produced by flattenRegisteredPlan. */
export type RegisteredFlatTaskPlan = {
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

/** @deprecated Prefer RegisteredFlatTaskPlan — kept for planner call sites. */
export type FlatTaskPlan = RegisteredFlatTaskPlan

export type BusinessSkillSnapshot = {
  skillIds: string[]
  instructions: string
}

export type JobExecutionProfile = {
  plannerCoreCode: ProviderCode | string
  sliceVerifierCoreCode: ProviderCode | string
  milestoneVerifierCoreCode: ProviderCode | string
  skills: {
    planner: BusinessSkillSnapshot
    taskWorker: BusinessSkillSnapshot
    sliceVerifier: BusinessSkillSnapshot
    milestoneVerifier: BusinessSkillSnapshot
  }
}

export type SavedJobPlan = {
  milestones: PlannerRegisteredMilestone[]
  tasks: RegisteredFlatTaskPlan[]
}
