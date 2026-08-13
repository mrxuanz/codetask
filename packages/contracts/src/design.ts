import { Type, type Static } from '@sinclair/typebox'

/** Durable planning/execution safety limits shared by every ingress path. */
export const MAX_EXECUTION_MILESTONES = 32
export const MAX_EXECUTION_SLICES_PER_MILESTONE = 64
export const MAX_EXECUTION_SLICES = 256
export const MAX_EXECUTION_TASKS_PER_SLICE = 128
export const MAX_EXECUTION_TASKS = 512
export const MAX_EXECUTION_TREE_BYTES = 4 * 1024 * 1024
export const MAX_JOB_SUBMISSION_BYTES = 8 * 1024 * 1024
export const MAX_TASK_CONTEXT_CHARS = 64 * 1024
export const MAX_NODE_TITLE_CHARS = 512
export const MAX_NODE_DESCRIPTION_CHARS = 8 * 1024
export const MAX_SUCCESS_CRITERIA_CHARS = 8 * 1024
export const MAX_DRAFT_REFERENCES = 128
export const MAX_NODE_LIST_ITEMS = 128
export const MAX_DRAFT_BYTES = 2 * 1024 * 1024
export const MAX_DRAFT_BODY_CHARS = 256 * 1024
export const MAX_DRAFT_LIST_ITEMS = 256
export const MAX_DRAFT_ABILITIES = 128
export const MAX_PATH_CHARS = 4096
export const MAX_MIME_TYPE_CHARS = 256

export const DraftStatusSchema = Type.Union([
  Type.Literal('editing'),
  Type.Literal('confirmed'),
  Type.Literal('archived')
])

export const RequirementsStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('confirmed')
])

export const DraftAbilitySchema = Type.Object({
  abilityCode: Type.String({ maxLength: MAX_NODE_TITLE_CHARS }),
  label: Type.String({ maxLength: MAX_NODE_TITLE_CHARS }),
  description: Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }),
  reason: Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }),
  recommendedCoreCode: Type.String({ maxLength: MAX_NODE_TITLE_CHARS }),
  sortOrder: Type.Optional(Type.Integer({ minimum: 0 }))
})

export const DraftReferenceSchema = Type.Object({
  id: Type.String({ maxLength: MAX_NODE_TITLE_CHARS }),
  source: Type.Optional(Type.String({ maxLength: MAX_NODE_TITLE_CHARS })),
  name: Type.String({ maxLength: MAX_NODE_TITLE_CHARS }),
  kind: Type.Union([Type.Literal('image'), Type.Literal('file'), Type.Literal('directory')]),
  mimeType: Type.Optional(Type.String({ maxLength: MAX_MIME_TYPE_CHARS })),
  description: Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }),
  attachmentId: Type.Optional(Type.String({ maxLength: MAX_NODE_TITLE_CHARS })),
  localPath: Type.Optional(Type.String({ maxLength: MAX_PATH_CHARS })),
  resolvedPath: Type.Optional(Type.String({ maxLength: MAX_PATH_CHARS })),
  assetUrl: Type.Optional(Type.String({ maxLength: MAX_PATH_CHARS })),
  sortOrder: Type.Optional(Type.Integer({ minimum: 0 }))
})

export const ExecutionProfileSchema = Type.Object({
  plannerCoreCode: Type.String(),
  sliceVerifierCoreCode: Type.String(),
  milestoneVerifierCoreCode: Type.String()
})

export const DraftLockedSectionsSchema = Type.Object({
  requirementsContract: Type.Optional(Type.Boolean()),
  abilities: Type.Optional(Type.Boolean()),
  references: Type.Optional(Type.Boolean()),
  acceptance: Type.Optional(Type.Boolean()),
  userFlow: Type.Optional(Type.Boolean()),
  techStack: Type.Optional(Type.Boolean())
})

export const AcceptanceCriterionSchema = Type.Object({
  id: Type.String({ maxLength: MAX_NODE_TITLE_CHARS }),
  given: Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }),
  when: Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }),
  then: Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS })
})

export const VerificationSuggestionSchema = Type.Object({
  command: Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }),
  appliesTo: Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS })
})

export const DraftSnapshotSchema = Type.Object({
  draftId: Type.String(),
  actorId: Type.String(),
  projectId: Type.String(),
  title: Type.String({ maxLength: MAX_NODE_TITLE_CHARS }),
  summary: Type.String({ maxLength: MAX_DRAFT_BODY_CHARS }),
  userFlow: Type.String({ maxLength: MAX_DRAFT_BODY_CHARS }),
  techStack: Type.String({ maxLength: MAX_DRAFT_BODY_CHARS }),
  nfr: Type.Array(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }), {
    maxItems: MAX_DRAFT_LIST_ITEMS
  }),
  acceptance: Type.Array(AcceptanceCriterionSchema, { maxItems: MAX_DRAFT_LIST_ITEMS }),
  verification: Type.Array(VerificationSuggestionSchema, { maxItems: MAX_DRAFT_LIST_ITEMS }),
  outOfScope: Type.Array(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }), {
    maxItems: MAX_DRAFT_LIST_ITEMS
  }),
  assumptions: Type.Array(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }), {
    maxItems: MAX_DRAFT_LIST_ITEMS
  }),
  requirementsMarkdown: Type.String({ maxLength: MAX_DRAFT_BODY_CHARS }),
  requirementsStatus: RequirementsStatusSchema,
  lockedSections: DraftLockedSectionsSchema,
  workspaceRoot: Type.String({ maxLength: MAX_PATH_CHARS }),
  status: DraftStatusSchema,
  lockRevision: Type.Integer({ minimum: 0 }),
  abilities: Type.Array(DraftAbilitySchema, { maxItems: MAX_DRAFT_ABILITIES }),
  references: Type.Array(DraftReferenceSchema, { maxItems: MAX_DRAFT_REFERENCES }),
  executionProfile: Type.Optional(ExecutionProfileSchema),
  capturedAt: Type.String()
})

export const ExecutionTaskSchema = Type.Object({
  id: Type.String(),
  sliceId: Type.String(),
  title: Type.String({ maxLength: MAX_NODE_TITLE_CHARS }),
  description: Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }),
  taskKind: Type.String(),
  abilityCode: Type.String(),
  coreCode: Type.String(),
  contextMarkdown: Type.String({ maxLength: MAX_TASK_CONTEXT_CHARS }),
  successCriteria: Type.String({ maxLength: MAX_SUCCESS_CRITERIA_CHARS }),
  referenceIds: Type.Array(Type.String(), { maxItems: MAX_DRAFT_REFERENCES }),
  referenceReason: Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }),
  requiredInputs: Type.Array(Type.String(), { maxItems: MAX_NODE_LIST_ITEMS }),
  dependsOnTaskIds: Type.Array(Type.String(), { maxItems: MAX_NODE_LIST_ITEMS }),
  canRunInParallel: Type.Boolean(),
  confirmed: Type.Boolean()
})

export const ExecutionSliceSchema = Type.Object({
  id: Type.String(),
  milestoneId: Type.String(),
  title: Type.String({ maxLength: MAX_NODE_TITLE_CHARS }),
  description: Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }),
  successCriteria: Type.String({ maxLength: MAX_SUCCESS_CRITERIA_CHARS }),
  dependsOnSliceIds: Type.Array(Type.String(), { maxItems: MAX_NODE_LIST_ITEMS }),
  confirmed: Type.Boolean(),
  tasks: Type.Array(ExecutionTaskSchema, { maxItems: MAX_EXECUTION_TASKS_PER_SLICE })
})

export const ExecutionMilestoneSchema = Type.Object({
  id: Type.String(),
  title: Type.String({ maxLength: MAX_NODE_TITLE_CHARS }),
  description: Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }),
  successCriteria: Type.String({ maxLength: MAX_SUCCESS_CRITERIA_CHARS }),
  confirmed: Type.Boolean(),
  slices: Type.Array(ExecutionSliceSchema, { maxItems: MAX_EXECUTION_SLICES_PER_MILESTONE })
})

export const ExecutionTreeSnapshotSchema = Type.Object({
  treeId: Type.String(),
  planningSessionId: Type.String(),
  revision: Type.Integer({ minimum: 0 }),
  milestones: Type.Array(ExecutionMilestoneSchema, { maxItems: MAX_EXECUTION_MILESTONES })
})

export const ReferenceManifestSchema = Type.Object({
  snapshotId: Type.String(),
  draftId: Type.String(),
  draftLockRevision: Type.Integer({ minimum: 0 }),
  contentHash: Type.String(),
  references: Type.Array(DraftReferenceSchema, { maxItems: MAX_DRAFT_REFERENCES }),
  createdAt: Type.String()
})

/** Frozen settings envelope on JobSubmission — payload is ExecutionSettingsSnapshot. */
export const JobExecutionSettingsEnvelopeSchema = Type.Object({
  settingsHash: Type.String(),
  capturedAt: Type.String(),
  payload: Type.Record(Type.String(), Type.Unknown())
})

export const JobSubmissionSchema = Type.Object({
  submissionId: Type.String(),
  idempotencyKey: Type.String(),
  actorId: Type.String(),
  projectId: Type.String(),
  title: Type.String(),
  summary: Type.String(),
  workspaceRoot: Type.String(),
  source: Type.Object({
    draftId: Type.String(),
    planningSessionId: Type.String()
  }),
  draftSnapshot: DraftSnapshotSchema,
  referenceManifest: ReferenceManifestSchema,
  executionProfile: ExecutionProfileSchema,
  executionSettings: JobExecutionSettingsEnvelopeSchema,
  executionTree: ExecutionTreeSnapshotSchema,
  createdAt: Type.String()
})

export const JobAcceptedSchema = Type.Object({
  submissionId: Type.String(),
  jobId: Type.String(),
  acceptedAt: Type.String()
})

export const PlanningSessionStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('planning'),
  Type.Literal('plan_editing'),
  Type.Literal('ready_to_publish'),
  Type.Literal('publishing'),
  Type.Literal('published'),
  Type.Literal('failed'),
  Type.Literal('cancelled')
])

export const CreateDraftBodySchema = Type.Object({
  projectId: Type.String({ maxLength: MAX_NODE_TITLE_CHARS }),
  title: Type.String({ minLength: 1, maxLength: MAX_NODE_TITLE_CHARS }),
  summary: Type.Optional(Type.String({ maxLength: MAX_DRAFT_BODY_CHARS })),
  userFlow: Type.Optional(Type.String({ maxLength: MAX_DRAFT_BODY_CHARS })),
  techStack: Type.Optional(Type.String({ maxLength: MAX_DRAFT_BODY_CHARS })),
  nfr: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }), {
      maxItems: MAX_DRAFT_LIST_ITEMS
    })
  ),
  acceptance: Type.Optional(
    Type.Array(AcceptanceCriterionSchema, { maxItems: MAX_DRAFT_LIST_ITEMS })
  ),
  verification: Type.Optional(
    Type.Array(VerificationSuggestionSchema, { maxItems: MAX_DRAFT_LIST_ITEMS })
  ),
  outOfScope: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }), {
      maxItems: MAX_DRAFT_LIST_ITEMS
    })
  ),
  assumptions: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }), {
      maxItems: MAX_DRAFT_LIST_ITEMS
    })
  ),
  requirementsMarkdown: Type.Optional(Type.String({ maxLength: MAX_DRAFT_BODY_CHARS }))
})

export const PatchDraftBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  title: Type.Optional(Type.String({ maxLength: MAX_NODE_TITLE_CHARS })),
  summary: Type.Optional(Type.String({ maxLength: MAX_DRAFT_BODY_CHARS })),
  userFlow: Type.Optional(Type.String({ maxLength: MAX_DRAFT_BODY_CHARS })),
  techStack: Type.Optional(Type.String({ maxLength: MAX_DRAFT_BODY_CHARS })),
  nfr: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }), {
      maxItems: MAX_DRAFT_LIST_ITEMS
    })
  ),
  acceptance: Type.Optional(
    Type.Array(AcceptanceCriterionSchema, { maxItems: MAX_DRAFT_LIST_ITEMS })
  ),
  verification: Type.Optional(
    Type.Array(VerificationSuggestionSchema, { maxItems: MAX_DRAFT_LIST_ITEMS })
  ),
  outOfScope: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }), {
      maxItems: MAX_DRAFT_LIST_ITEMS
    })
  ),
  assumptions: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }), {
      maxItems: MAX_DRAFT_LIST_ITEMS
    })
  ),
  requirementsMarkdown: Type.Optional(Type.String({ maxLength: MAX_DRAFT_BODY_CHARS }))
})

export const PatchAbilitiesBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  abilities: Type.Array(DraftAbilitySchema, { maxItems: MAX_DRAFT_ABILITIES })
})

export const PatchExecutionProfileBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  executionProfile: ExecutionProfileSchema
})

export const ConfirmDraftBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 })
})

export const UnlockDraftBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  cancelActivePlanning: Type.Optional(Type.Boolean())
})

export const CreatePlanningSessionBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 })
})

export const PatchTreeNodeBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  title: Type.Optional(Type.String({ maxLength: MAX_NODE_TITLE_CHARS })),
  description: Type.Optional(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS })),
  successCriteria: Type.Optional(Type.String({ maxLength: MAX_SUCCESS_CRITERIA_CHARS })),
  contextMarkdown: Type.Optional(Type.String({ maxLength: MAX_TASK_CONTEXT_CHARS })),
  abilityCode: Type.Optional(Type.String({ maxLength: MAX_NODE_TITLE_CHARS })),
  coreCode: Type.Optional(Type.String({ maxLength: MAX_NODE_TITLE_CHARS })),
  canRunInParallel: Type.Optional(Type.Boolean()),
  referenceIds: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_NODE_TITLE_CHARS }), {
      maxItems: MAX_DRAFT_REFERENCES
    })
  ),
  referenceReason: Type.Optional(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS })),
  requiredInputs: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }), {
      maxItems: MAX_NODE_LIST_ITEMS
    })
  ),
  dependsOnSliceIds: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_NODE_TITLE_CHARS }), {
      maxItems: MAX_NODE_LIST_ITEMS
    })
  ),
  dependsOnTaskIds: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_NODE_TITLE_CHARS }), {
      maxItems: MAX_NODE_LIST_ITEMS
    })
  )
})

export const AddDraftReferenceBodySchema = Type.Intersect([
  Type.Omit(DraftReferenceSchema, ['id']),
  Type.Object({ expectedRevision: Type.Integer({ minimum: 0 }) })
])

export const PatchDraftReferenceBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  name: Type.Optional(Type.String({ maxLength: MAX_NODE_TITLE_CHARS })),
  description: Type.Optional(Type.String({ maxLength: MAX_NODE_DESCRIPTION_CHARS }))
})

export const ConfirmTreeNodeBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 })
})

export const PublishPlanningBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  idempotencyKey: Type.String({ minLength: 1 })
})

export type DraftStatus = Static<typeof DraftStatusSchema>
export type AcceptanceCriterion = Static<typeof AcceptanceCriterionSchema>
export type DraftSnapshot = Static<typeof DraftSnapshotSchema>
export type DraftAbility = Static<typeof DraftAbilitySchema>
export type DraftReference = Static<typeof DraftReferenceSchema>
export type ExecutionProfile = Static<typeof ExecutionProfileSchema>
export type ExecutionTreeSnapshot = Static<typeof ExecutionTreeSnapshotSchema>
export type ExecutionMilestone = Static<typeof ExecutionMilestoneSchema>
export type ExecutionSlice = Static<typeof ExecutionSliceSchema>
export type ExecutionTask = Static<typeof ExecutionTaskSchema>
export type ReferenceManifest = Static<typeof ReferenceManifestSchema>
export type JobExecutionSettingsEnvelope = Static<typeof JobExecutionSettingsEnvelopeSchema>
export type JobSubmission = Static<typeof JobSubmissionSchema>
export type JobAccepted = Static<typeof JobAcceptedSchema>
export type PlanningSessionStatus = Static<typeof PlanningSessionStatusSchema>
export type CreateDraftBody = Static<typeof CreateDraftBodySchema>
export type PatchDraftBody = Static<typeof PatchDraftBodySchema>
export type PatchAbilitiesBody = Static<typeof PatchAbilitiesBodySchema>
export type PatchExecutionProfileBody = Static<typeof PatchExecutionProfileBodySchema>
export type ConfirmDraftBody = Static<typeof ConfirmDraftBodySchema>
export type UnlockDraftBody = Static<typeof UnlockDraftBodySchema>
export type CreatePlanningSessionBody = Static<typeof CreatePlanningSessionBodySchema>
export type PatchTreeNodeBody = Static<typeof PatchTreeNodeBodySchema>
export type AddDraftReferenceBody = Static<typeof AddDraftReferenceBodySchema>
export type PatchDraftReferenceBody = Static<typeof PatchDraftReferenceBodySchema>
export type ConfirmTreeNodeBody = Static<typeof ConfirmTreeNodeBodySchema>
export type PublishPlanningBody = Static<typeof PublishPlanningBodySchema>

export function findExecutionTreeLimitViolation(tree: ExecutionTreeSnapshot): string | null {
  if (tree.milestones.length > MAX_EXECUTION_MILESTONES) {
    return `Execution tree exceeds ${MAX_EXECUTION_MILESTONES} milestones`
  }
  let sliceCount = 0
  let taskCount = 0
  for (const milestone of tree.milestones) {
    if (milestone.title.length > MAX_NODE_TITLE_CHARS) return 'Milestone title is too large'
    if (milestone.description.length > MAX_NODE_DESCRIPTION_CHARS) {
      return 'Milestone description is too large'
    }
    if (milestone.successCriteria.length > MAX_SUCCESS_CRITERIA_CHARS) {
      return 'Milestone success criteria is too large'
    }
    if (milestone.slices.length > MAX_EXECUTION_SLICES_PER_MILESTONE) {
      return `A milestone exceeds ${MAX_EXECUTION_SLICES_PER_MILESTONE} slices`
    }
    sliceCount += milestone.slices.length
    for (const slice of milestone.slices) {
      if (slice.title.length > MAX_NODE_TITLE_CHARS) return 'Slice title is too large'
      if (slice.description.length > MAX_NODE_DESCRIPTION_CHARS) {
        return 'Slice description is too large'
      }
      if (slice.successCriteria.length > MAX_SUCCESS_CRITERIA_CHARS) {
        return 'Slice success criteria is too large'
      }
      if (slice.tasks.length > MAX_EXECUTION_TASKS_PER_SLICE) {
        return `A slice exceeds ${MAX_EXECUTION_TASKS_PER_SLICE} tasks`
      }
      taskCount += slice.tasks.length
      for (const task of slice.tasks) {
        if (task.title.length > MAX_NODE_TITLE_CHARS) return 'Task title is too large'
        if (task.description.length > MAX_NODE_DESCRIPTION_CHARS) {
          return 'Task description is too large'
        }
        if (task.contextMarkdown.length > MAX_TASK_CONTEXT_CHARS) {
          return `Task context exceeds ${MAX_TASK_CONTEXT_CHARS} characters`
        }
        if (task.successCriteria.length > MAX_SUCCESS_CRITERIA_CHARS) {
          return 'Task success criteria is too large'
        }
        if (
          task.referenceIds.length > MAX_DRAFT_REFERENCES ||
          task.requiredInputs.length > MAX_NODE_LIST_ITEMS ||
          task.dependsOnTaskIds.length > MAX_NODE_LIST_ITEMS
        ) {
          return 'Task contains too many references, inputs, or dependencies'
        }
      }
    }
  }
  if (sliceCount > MAX_EXECUTION_SLICES) {
    return `Execution tree exceeds ${MAX_EXECUTION_SLICES} slices`
  }
  if (taskCount > MAX_EXECUTION_TASKS) {
    return `Execution tree exceeds ${MAX_EXECUTION_TASKS} tasks`
  }
  const bytes = new TextEncoder().encode(JSON.stringify(tree)).byteLength
  if (bytes > MAX_EXECUTION_TREE_BYTES) {
    return `Execution tree exceeds ${MAX_EXECUTION_TREE_BYTES} bytes`
  }
  return null
}
