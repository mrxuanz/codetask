import type { MessageAttachment } from './ui-conversation.ts'

export const THREAD_WORKSPACE_BINDING_POLICY =
  'The execution workspace is always bound server-side to the current thread or project folder. Never include workspacePath or createDirIfNotExists in draft confirmation requests; the backend ignores any such fields.'

export const THREAD_WORKSPACE_FIELD_KEYS = ['workspacePath', 'createDirIfNotExists'] as const

export type TaskLaunchAbilityCatalogItem = {
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

export type TaskLaunchDraftAcceptance = {
  id: string
  given: string
  when: string
  then: string
}

export type TaskLaunchDraftAbility = {
  abilityCode: string
  label?: string
  description?: string
  reason?: string
  recommendedCoreCode?: string
}

export type TaskLaunchDraftRequirementsContract = {
  markdown?: string
  status?: 'pending' | 'confirmed' | string
  confirmedAt?: string | null
}

export type DraftLifecycleStatus = 'editing' | 'confirmed' | 'archived'

export type TaskLaunchDraftLockedSections = {
  requirementsContract?: boolean
  abilities?: boolean
  references?: boolean
  acceptance?: boolean
  userFlow?: boolean
  techStack?: boolean
  [section: string]: boolean | undefined
}

export type TaskLaunchDraftReference = {
  id: string
  name: string
  mimeType: string
  kind: 'image' | 'file' | 'directory'
  assetUrl: string
  description?: string | undefined
  source?: 'upload' | 'import' | 'message' | 'local_corpus' | undefined
  localPath?: string | undefined
}

export type DraftExecutionConfig = {
  plannerCoreCode: string
  sliceVerifierCoreCode: string
  milestoneVerifierCoreCode: string
}

export type TaskLaunchDraftPayload = {
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
  launchedJobId?: string | null
  designSessionId?: string | null
  lockedSections?: TaskLaunchDraftLockedSections
  abilities?: TaskLaunchDraftAbility[]
  references?: TaskLaunchDraftReference[]
  sourceAttachments?: MessageAttachment[]
  executionConfig?: DraftExecutionConfig
  revision?: number
  collecting?: boolean
}

export type ProposedTaskDraft = {
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
