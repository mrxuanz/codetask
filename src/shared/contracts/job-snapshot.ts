import type { JobExecutionProfile, SavedJobPlan } from './plan'
import type { JobReferenceManifest } from '../job-references'
import type { ThreadJobAbilityDto } from './jobs'

export interface JobSnapshot {
  designSessionId: string
  draftRevision: number
  planRevision: number
  manifestRevision: number
  workspaceRoot: string
  referenceManifest: JobReferenceManifest
  executionPlan: SavedJobPlan
  executionProfile: JobExecutionProfile
  abilities: ThreadJobAbilityDto[]
}
