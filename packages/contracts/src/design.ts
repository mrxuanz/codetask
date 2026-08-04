import { Type, type Static } from '@sinclair/typebox'

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
  abilityCode: Type.String(),
  label: Type.String(),
  description: Type.String(),
  reason: Type.String(),
  recommendedCoreCode: Type.String(),
  sortOrder: Type.Optional(Type.Integer({ minimum: 0 }))
})

export const DraftReferenceSchema = Type.Object({
  id: Type.String(),
  source: Type.Optional(Type.String()),
  name: Type.String(),
  kind: Type.Union([Type.Literal('image'), Type.Literal('file'), Type.Literal('directory')]),
  mimeType: Type.Optional(Type.String()),
  description: Type.String(),
  attachmentId: Type.Optional(Type.String()),
  localPath: Type.Optional(Type.String()),
  resolvedPath: Type.Optional(Type.String()),
  assetUrl: Type.Optional(Type.String()),
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
  id: Type.String(),
  given: Type.String(),
  when: Type.String(),
  then: Type.String()
})

export const VerificationSuggestionSchema = Type.Object({
  command: Type.String(),
  appliesTo: Type.String()
})

export const DraftSnapshotSchema = Type.Object({
  draftId: Type.String(),
  actorId: Type.String(),
  projectId: Type.String(),
  title: Type.String(),
  summary: Type.String(),
  userFlow: Type.String(),
  techStack: Type.String(),
  nfr: Type.Array(Type.String()),
  acceptance: Type.Array(AcceptanceCriterionSchema),
  verification: Type.Array(VerificationSuggestionSchema),
  outOfScope: Type.Array(Type.String()),
  assumptions: Type.Array(Type.String()),
  requirementsMarkdown: Type.String(),
  requirementsStatus: RequirementsStatusSchema,
  lockedSections: DraftLockedSectionsSchema,
  workspaceRoot: Type.String(),
  status: DraftStatusSchema,
  lockRevision: Type.Integer({ minimum: 0 }),
  abilities: Type.Array(DraftAbilitySchema),
  references: Type.Array(DraftReferenceSchema),
  executionProfile: Type.Optional(ExecutionProfileSchema),
  capturedAt: Type.String()
})

export const ExecutionTaskSchema = Type.Object({
  id: Type.String(),
  sliceId: Type.String(),
  title: Type.String(),
  description: Type.String(),
  taskKind: Type.String(),
  abilityCode: Type.String(),
  coreCode: Type.String(),
  contextMarkdown: Type.String(),
  successCriteria: Type.String(),
  referenceIds: Type.Array(Type.String()),
  dependsOnTaskIds: Type.Array(Type.String()),
  canRunInParallel: Type.Boolean(),
  confirmed: Type.Boolean()
})

export const ExecutionSliceSchema = Type.Object({
  id: Type.String(),
  milestoneId: Type.String(),
  title: Type.String(),
  description: Type.String(),
  successCriteria: Type.String(),
  confirmed: Type.Boolean(),
  tasks: Type.Array(ExecutionTaskSchema)
})

export const ExecutionMilestoneSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.String(),
  successCriteria: Type.String(),
  confirmed: Type.Boolean(),
  slices: Type.Array(ExecutionSliceSchema)
})

export const ExecutionTreeSnapshotSchema = Type.Object({
  treeId: Type.String(),
  planningSessionId: Type.String(),
  revision: Type.Integer({ minimum: 0 }),
  milestones: Type.Array(ExecutionMilestoneSchema)
})

export const ReferenceManifestSchema = Type.Object({
  snapshotId: Type.String(),
  draftId: Type.String(),
  draftLockRevision: Type.Integer({ minimum: 0 }),
  contentHash: Type.String(),
  references: Type.Array(DraftReferenceSchema),
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
  projectId: Type.String(),
  title: Type.String({ minLength: 1 }),
  summary: Type.Optional(Type.String()),
  userFlow: Type.Optional(Type.String()),
  techStack: Type.Optional(Type.String()),
  nfr: Type.Optional(Type.Array(Type.String())),
  acceptance: Type.Optional(Type.Array(AcceptanceCriterionSchema)),
  verification: Type.Optional(Type.Array(VerificationSuggestionSchema)),
  outOfScope: Type.Optional(Type.Array(Type.String())),
  assumptions: Type.Optional(Type.Array(Type.String())),
  requirementsMarkdown: Type.Optional(Type.String())
})

export const PatchDraftBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  title: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  userFlow: Type.Optional(Type.String()),
  techStack: Type.Optional(Type.String()),
  nfr: Type.Optional(Type.Array(Type.String())),
  acceptance: Type.Optional(Type.Array(AcceptanceCriterionSchema)),
  verification: Type.Optional(Type.Array(VerificationSuggestionSchema)),
  outOfScope: Type.Optional(Type.Array(Type.String())),
  assumptions: Type.Optional(Type.Array(Type.String())),
  requirementsMarkdown: Type.Optional(Type.String())
})

export const PatchAbilitiesBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  abilities: Type.Array(DraftAbilitySchema)
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
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  successCriteria: Type.Optional(Type.String()),
  contextMarkdown: Type.Optional(Type.String()),
  abilityCode: Type.Optional(Type.String()),
  coreCode: Type.Optional(Type.String()),
  canRunInParallel: Type.Optional(Type.Boolean()),
  referenceIds: Type.Optional(Type.Array(Type.String())),
  dependsOnTaskIds: Type.Optional(Type.Array(Type.String()))
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
export type ConfirmTreeNodeBody = Static<typeof ConfirmTreeNodeBodySchema>
export type PublishPlanningBody = Static<typeof PublishPlanningBodySchema>
