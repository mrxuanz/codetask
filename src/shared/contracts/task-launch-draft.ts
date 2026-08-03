import type { MessageAttachment } from './conversation'
import type { SupportedCoreCode } from '../providers/codes'

export const THREAD_WORKSPACE_BINDING_POLICY =
  'The execution workspace is always bound server-side to the current thread or project folder. Never include workspacePath or createDirIfNotExists in draft confirmation requests; the backend ignores any such fields.'

export const THREAD_WORKSPACE_FIELD_KEYS = ['workspacePath', 'createDirIfNotExists'] as const

export interface TaskLaunchAbilityCatalogItem {
  code: string
  label: string
  description: string
}

export const TASK_LAUNCH_ABILITY_CATALOG: TaskLaunchAbilityCatalogItem[] = [
  {
    code: 'requirements-analysis',
    label: 'Analyze Requirements',
    description: 'Analyze and confirm requirements, acceptance criteria, and key constraints.'
  },
  {
    code: 'solution-design',
    label: 'Design Solution',
    description: 'Design the implementation path, module boundaries, and technical approach.'
  },
  {
    code: 'project-setup',
    label: 'Project Setup',
    description: 'Create the project skeleton, base configuration, and startup scripts.'
  },
  {
    code: 'dependency-management',
    label: 'Dependency Management',
    description: 'Maintain packages, lockfiles, and dependency installation configuration.'
  },
  {
    code: 'scaffolding',
    label: 'Scaffolding',
    description: 'Create version-control-friendly directory structure and placeholder files.'
  },
  {
    code: 'backend-implementation',
    label: 'Backend Implementation',
    description: 'Implement server-side interfaces, business logic, and persistence changes.'
  },
  {
    code: 'frontend-implementation',
    label: 'Frontend Implementation',
    description: 'Implement pages, interactions, and frontend integration changes.'
  },
  {
    code: 'data-modeling',
    label: 'Data Modeling',
    description: 'Design table structures, entity relationships, and migration impact.'
  },
  {
    code: 'testing-validation',
    label: 'Testing & Validation',
    description:
      'Add test files, checklists, evidence notes, or validation tasks requested by the user.'
  },
  {
    code: 'documentation-handoff',
    label: 'Documentation Handoff',
    description:
      'Compile delivery notes, usage instructions, change evidence, and manual verification suggestions.'
  }
]

export interface TaskLaunchDraftAcceptance {
  id: string
  given: string
  when: string
  then: string
}

export interface TaskLaunchDraftAbility {
  abilityCode: string
  label?: string
  description?: string
  reason?: string
  recommendedCoreCode?: SupportedCoreCode | string
}

export interface TaskLaunchDraftRequirementsContract {
  markdown?: string
  status?: 'pending' | 'confirmed' | string
  confirmedAt?: string | null
}

export type DraftLifecycleStatus = 'editing' | 'confirmed' | 'archived'

export interface TaskLaunchDraftLockedSections {
  requirementsContract?: boolean
  abilities?: boolean
  references?: boolean
  acceptance?: boolean
  userFlow?: boolean
  techStack?: boolean
  [section: string]: boolean | undefined
}

export interface TaskLaunchDraftReference {
  id: string
  name: string
  mimeType: string
  kind: 'image' | 'file' | 'directory'
  assetUrl: string
  description?: string | undefined
  source?: 'upload' | 'import' | 'message' | 'local_corpus' | undefined
  localPath?: string | undefined
}

export interface DraftExecutionConfig {
  plannerCoreCode: string
  sliceVerifierCoreCode: string
  milestoneVerifierCoreCode: string
}

/**
 * Shared create-task / Design draft form payload.
 * Fields are optional so UI hydration and partial updates share one type.
 */
export interface TaskLaunchDraftPayload {
  draftId?: string
  sourceMessageId?: string
  title?: string
  summary?: string
  userFlow?: string
  techStack?: string
  nfr?: string[]
  acceptance?: TaskLaunchDraftAcceptance[]
  verification?: Array<{ command: string; appliesTo: string }>
  outOfScope?: string[]
  assumptions?: string[]
  requirementsContract?: TaskLaunchDraftRequirementsContract
  workspacePath?: string
  status?: DraftLifecycleStatus | 'pending' | 'launched' | string
  linkedPlanId?: string | null
  /** Immutable execution Job produced from this draft, if it has been published. */
  launchedJobId?: string | null
  /** Draft-owned planning session retained independently from the published Job. */
  designSessionId?: string | null
  lockedSections?: TaskLaunchDraftLockedSections
  abilities?: TaskLaunchDraftAbility[]
  references?: TaskLaunchDraftReference[]
  sourceAttachments?: MessageAttachment[]
  /** Per-launch CLI choices; captured with role Skills in the Job's separate execution profile. */
  executionConfig?: DraftExecutionConfig
  revision?: number

  collecting?: boolean
}

export interface ProposedTaskDraft {
  title: string
  summary: string
  userFlow: string
  techStack: string
  nfr: string[]
  acceptance: TaskLaunchDraftAcceptance[]
  verification: Array<{ command: string; appliesTo: string }>
  outOfScope: string[]
  assumptions: string[]
  abilities: Array<TaskLaunchDraftAbility & { abilityCode: string }>
}
