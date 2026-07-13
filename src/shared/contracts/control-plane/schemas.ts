import { Type, type Static } from '@sinclair/typebox'

export const JobStateSchema = Type.Union([
  Type.Literal('planning_queued'),
  Type.Literal('planning_running'),
  Type.Literal('plan_review'),
  Type.Literal('execution_queued'),
  Type.Literal('execution_running'),
  Type.Literal('pausing'),
  Type.Literal('paused'),
  Type.Literal('applying_changes'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled')
])

export type JobState = Static<typeof JobStateSchema>

export const JobActionSchema = Type.Union([
  Type.Literal('pause'),
  Type.Literal('continue'),
  Type.Literal('cancel'),
  Type.Literal('restart_execution'),
  Type.Literal('replan'),
  Type.Literal('confirm_plan'),
  Type.Literal('edit_plan'),
  Type.Literal('delete')
])

export type JobAction = Static<typeof JobActionSchema>

export const ControlIntentSchema = Type.Union([
  Type.Literal('none'),
  Type.Literal('pause')
])

export type ControlIntent = Static<typeof ControlIntentSchema>

export const ResumeTargetSchema = Type.Union([
  Type.Literal('planning_queued'),
  Type.Literal('execution_queued')
])

export type ResumeTarget = Static<typeof ResumeTargetSchema>

export const RunKindSchema = Type.Union([
  Type.Literal('planning'),
  Type.Literal('execution')
])

export type RunKind = Static<typeof RunKindSchema>

export const RecoverabilitySchema = Type.Union([
  Type.Literal('recoverable'),
  Type.Literal('non_recoverable')
])

export type Recoverability = Static<typeof RecoverabilitySchema>

export const JobAggregateSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    threadId: Type.String({ minLength: 1, maxLength: 128 }),
    projectId: Type.String({ minLength: 1, maxLength: 128 }),
    state: JobStateSchema,
    stateRevision: Type.Integer({ minimum: 1 }),
    controlIntent: ControlIntentSchema,
    resumeTarget: Type.Union([ResumeTargetSchema, Type.Null()]),
    currentPlanRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    executionGeneration: Type.Integer({ minimum: 0 }),
    activeRunId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    lastFailureId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()])
  },
  { additionalProperties: false }
)

export type JobAggregate = Static<typeof JobAggregateSchema>

export const ActionRuleContextSchema = Type.Object(
  {
    state: JobStateSchema,
    recoverability: Type.Union([RecoverabilitySchema, Type.Null()]),
    hasConfirmedPlan: Type.Boolean()
  },
  { additionalProperties: false }
)

export type ActionRuleContext = Static<typeof ActionRuleContextSchema>
