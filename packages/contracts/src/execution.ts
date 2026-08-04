import { Type, type Static } from '@sinclair/typebox'

export const JobStateSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('pausing'),
  Type.Literal('paused'),
  Type.Literal('cancelling'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled')
])

export const JobControlIntentSchema = Type.Union([
  Type.Literal('none'),
  Type.Literal('pause'),
  Type.Literal('continue'),
  Type.Literal('cancel')
])

export const JobActionSchema = Type.Union([
  Type.Literal('pause'),
  Type.Literal('continue'),
  Type.Literal('cancel'),
  Type.Literal('restart'),
  Type.Literal('delete')
])

export const WorkKindSchema = Type.Union([
  Type.Literal('task'),
  Type.Literal('preparation-repair'),
  Type.Literal('implementation-repair'),
  Type.Literal('evidence-repair')
])

export const WorkStateSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('leased'),
  Type.Literal('running'),
  Type.Literal('reported'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('blocked'),
  Type.Literal('cancelled'),
  Type.Literal('skipped')
])

export const WorkDependencyReasonSchema = Type.Union([
  Type.Literal('planner'),
  Type.Literal('implicit-order'),
  Type.Literal('repair')
])

export const ProviderCodeSchema = Type.Union([
  Type.Literal('codex'),
  Type.Literal('claude'),
  Type.Literal('opencode'),
  Type.Literal('cursor')
])

export const TaskEvidenceSchema = Type.Object({
  status: Type.Union([Type.Literal('completed'), Type.Literal('blocked'), Type.Literal('failed')]),
  summary: Type.String(),
  changedFiles: Type.Array(Type.String()),
  evidence: Type.Array(Type.String()),
  validation: Type.Object({
    ran: Type.Boolean(),
    command: Type.Optional(Type.String()),
    outcome: Type.Union([
      Type.Literal('passed'),
      Type.Literal('failed'),
      Type.Literal('skipped'),
      Type.Literal('not-applicable')
    ]),
    notes: Type.Optional(Type.String())
  }),
  blockers: Type.Optional(Type.Array(Type.String()))
})

export const SliceVerdictStatusSchema = Type.Union([
  Type.Literal('progress-ok'),
  Type.Literal('needs-repair'),
  Type.Literal('blocked'),
  Type.Literal('inconclusive')
])

export const MilestoneVerdictStatusSchema = Type.Union([
  Type.Literal('passed'),
  Type.Literal('needs-repair'),
  Type.Literal('blocked'),
  Type.Literal('inconclusive')
])

export const ConfidenceSchema = Type.Union([
  Type.Literal('high'),
  Type.Literal('medium'),
  Type.Literal('low')
])

export const EvidenceTraceItemSchema = Type.Object({
  claim: Type.String(),
  evidenceRef: Type.String(),
  status: Type.String()
})

export const RepairSuggestionSchema = Type.Object({
  kind: WorkKindSchema,
  title: Type.String(),
  description: Type.String(),
  targetWorkId: Type.Optional(Type.String()),
  targetSliceId: Type.Optional(Type.String()),
  successCriteria: Type.String()
})

export const SliceVerdictSchema = Type.Object({
  status: SliceVerdictStatusSchema,
  confidence: ConfidenceSchema,
  summary: Type.String(),
  satisfiedSignals: Type.Array(Type.String()),
  missingSignals: Type.Array(Type.String()),
  questionableClaims: Type.Array(Type.String()),
  evidenceTrace: Type.Array(EvidenceTraceItemSchema),
  repairSuggestions: Type.Array(RepairSuggestionSchema)
})

export const MilestoneVerdictSchema = Type.Object({
  status: MilestoneVerdictStatusSchema,
  confidence: ConfidenceSchema,
  summary: Type.String(),
  requirementTrace: Type.Array(EvidenceTraceItemSchema),
  sliceAssessments: Type.Array(
    Type.Object({
      sliceId: Type.String(),
      status: Type.String(),
      summary: Type.String()
    })
  ),
  repairTasks: Type.Array(RepairSuggestionSchema)
})

export const JobCommandBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  idempotencyKey: Type.String({ minLength: 1 }),
  authorizeReplay: Type.Optional(Type.Boolean())
})

export const JobCommandResultSchema = Type.Object({
  jobId: Type.String(),
  state: JobStateSchema,
  stateRevision: Type.Integer({ minimum: 0 }),
  accepted: Type.Boolean()
})

export const JobSummarySchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  summary: Type.String(),
  state: JobStateSchema,
  stateRevision: Type.Integer({ minimum: 0 }),
  controlIntent: JobControlIntentSchema,
  executionGeneration: Type.Integer({ minimum: 0 }),
  projectId: Type.String(),
  actorId: Type.String(),
  workspaceRoot: Type.String(),
  queuedAt: Type.Union([Type.String(), Type.Null()]),
  startedAt: Type.Union([Type.String(), Type.Null()]),
  terminalAt: Type.Union([Type.String(), Type.Null()]),
  availableActions: Type.Array(JobActionSchema),
  recoveryReason: Type.Union([Type.String(), Type.Null()]),
  lastError: Type.Optional(Type.Unknown())
})

export const JobDetailSchema = Type.Intersect([
  JobSummarySchema,
  Type.Object({
    sourceDraftId: Type.String(),
    sourcePlanningSessionId: Type.String(),
    currentRunId: Type.Union([Type.String(), Type.Null()]),
    suspensionKind: Type.Union([Type.String(), Type.Null()]),
    queuePosition: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    createdAt: Type.String(),
    updatedAt: Type.String()
  })
])

export const WorkItemDtoSchema = Type.Object({
  id: Type.String(),
  jobId: Type.String(),
  generation: Type.Integer({ minimum: 0 }),
  sourceTaskId: Type.String(),
  parentWorkId: Type.Union([Type.String(), Type.Null()]),
  milestoneId: Type.String(),
  sliceId: Type.String(),
  kind: WorkKindSchema,
  title: Type.String(),
  description: Type.String(),
  contextMarkdown: Type.String(),
  abilityCode: Type.String(),
  providerCode: ProviderCodeSchema,
  successCriteria: Type.String(),
  canRunInParallel: Type.Boolean(),
  state: WorkStateSchema,
  stateRevision: Type.Integer({ minimum: 0 }),
  sortOrder: Type.Integer({ minimum: 0 })
})

export const JobTreeDtoSchema = Type.Object({
  jobId: Type.String(),
  generation: Type.Integer({ minimum: 0 }),
  milestones: Type.Array(
    Type.Object({
      id: Type.String(),
      sourceMilestoneId: Type.String(),
      title: Type.String(),
      description: Type.String(),
      successCriteria: Type.String(),
      state: Type.String(),
      sortOrder: Type.Integer({ minimum: 0 }),
      slices: Type.Array(
        Type.Object({
          id: Type.String(),
          sourceSliceId: Type.String(),
          title: Type.String(),
          description: Type.String(),
          successCriteria: Type.String(),
          state: Type.String(),
          verificationState: Type.String(),
          sortOrder: Type.Integer({ minimum: 0 }),
          workItems: Type.Array(WorkItemDtoSchema)
        })
      )
    })
  )
})

export const QueueEntryDtoSchema = Type.Object({
  jobId: Type.String(),
  generation: Type.Integer({ minimum: 0 }),
  status: Type.String(),
  priority: Type.Integer(),
  sequence: Type.Integer({ minimum: 0 }),
  position: Type.Integer({ minimum: 1 }),
  enqueuedAt: Type.String(),
  title: Type.String(),
  state: JobStateSchema
})

export const ExecutionEventNameSchema = Type.Union([
  Type.Literal('job.changed'),
  Type.Literal('job.queue.changed'),
  Type.Literal('job.run.changed'),
  Type.Literal('work.changed'),
  Type.Literal('verification.changed'),
  Type.Literal('repair.created'),
  Type.Literal('job.completed'),
  Type.Literal('job.deleted'),
  Type.Literal('realtime.resync-required')
])

export type JobState = Static<typeof JobStateSchema>
export type JobControlIntent = Static<typeof JobControlIntentSchema>
export type JobAction = Static<typeof JobActionSchema>
export type WorkKind = Static<typeof WorkKindSchema>
export type WorkState = Static<typeof WorkStateSchema>
export type WorkDependencyReason = Static<typeof WorkDependencyReasonSchema>
export type ProviderCode = Static<typeof ProviderCodeSchema>
export type TaskEvidence = Static<typeof TaskEvidenceSchema>
export type SliceVerdict = Static<typeof SliceVerdictSchema>
export type MilestoneVerdict = Static<typeof MilestoneVerdictSchema>
export type JobCommandBody = Static<typeof JobCommandBodySchema>
export type JobCommandResult = Static<typeof JobCommandResultSchema>
export type JobSummary = Static<typeof JobSummarySchema>
export type JobDetail = Static<typeof JobDetailSchema>
export type WorkItemDto = Static<typeof WorkItemDtoSchema>
export type JobTreeDto = Static<typeof JobTreeDtoSchema>
export type QueueEntryDto = Static<typeof QueueEntryDtoSchema>
export type ExecutionEventName = Static<typeof ExecutionEventNameSchema>
