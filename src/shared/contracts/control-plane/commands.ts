import { Type, type Static, type TSchema } from '@sinclair/typebox'

export const ActorContextSchema = Type.Object(
  {
    username: Type.String({ minLength: 1, maxLength: 128 }),
    requestId: Type.String({ minLength: 1, maxLength: 128 })
  },
  { additionalProperties: false }
)

export type ActorContext = Static<typeof ActorContextSchema>

export const UserCommandEnvelopeSchema = Type.Object(
  {
    actor: ActorContextSchema,
    jobId: Type.String({ minLength: 1, maxLength: 128 }),
    expectedRevision: Type.Integer({ minimum: 1 }),
    idempotencyKey: Type.String({ format: 'uuid' })
  },
  { additionalProperties: false }
)

export type UserCommandEnvelope = Static<typeof UserCommandEnvelopeSchema>

export const PayloadCommandEnvelopeSchema = <TPayload extends TSchema>(
  payloadSchema: TPayload
): TSchema =>
  Type.Object(
    {
      actor: ActorContextSchema,
      jobId: Type.String({ minLength: 1, maxLength: 128 }),
      expectedRevision: Type.Integer({ minimum: 1 }),
      idempotencyKey: Type.String({ format: 'uuid' }),
      payload: payloadSchema
    },
    { additionalProperties: false }
  )

export type PayloadCommandEnvelope<TPayload> = UserCommandEnvelope & {
  readonly payload: TPayload
}

export const WorkerCommandEnvelopeSchema = <TPayload extends TSchema>(
  payloadSchema: TPayload
): TSchema =>
  Type.Object(
    {
      jobId: Type.String({ minLength: 1, maxLength: 128 }),
      expectedRevision: Type.Integer({ minimum: 1 }),
      runId: Type.String({ minLength: 1, maxLength: 128 }),
      fenceToken: Type.String({ minLength: 1, maxLength: 128 }),
      executionGeneration: Type.Integer({ minimum: 0 }),
      payload: payloadSchema
    },
    { additionalProperties: false }
  )

export type WorkerCommandEnvelope<TPayload> = {
  readonly jobId: string
  readonly expectedRevision: number
  readonly runId: string
  readonly fenceToken: string
  readonly executionGeneration: number
  readonly payload: TPayload
}

export const CancelJobPayloadSchema = Type.Object(
  {
    reasonCode: Type.String({ minLength: 1, maxLength: 128 })
  },
  { additionalProperties: false }
)

export type CancelJobPayload = Static<typeof CancelJobPayloadSchema>

export const RestartExecutionPayloadSchema = Type.Object(
  {},
  { additionalProperties: false }
)

export type RestartExecutionPayload = Static<typeof RestartExecutionPayloadSchema>

export const PauseAcknowledgedPayloadSchema = Type.Object(
  {},
  { additionalProperties: false }
)

export type PauseAcknowledgedPayload = Static<typeof PauseAcknowledgedPayloadSchema>

export const TaskCheckpointPayloadSchema = Type.Object(
  {
    attemptId: Type.String({ minLength: 1, maxLength: 128 }),
    result: Type.Unknown()
  },
  { additionalProperties: false }
)

export type TaskCheckpointPayload = Static<typeof TaskCheckpointPayloadSchema>

export const StartVerificationPayloadSchema = Type.Object(
  {
    scopeType: Type.Union([Type.Literal('slice'), Type.Literal('milestone')]),
    scopeId: Type.String({ minLength: 1, maxLength: 128 })
  },
  { additionalProperties: false }
)

export type StartVerificationPayload = Static<typeof StartVerificationPayloadSchema>

export const CompleteSliceVerificationPayloadSchema = Type.Object(
  {
    verificationId: Type.String({ minLength: 1, maxLength: 128 }),
    scopeId: Type.String({ minLength: 1, maxLength: 128 }),
    verdict: Type.Unknown()
  },
  { additionalProperties: false }
)

export type CompleteSliceVerificationPayload = Static<typeof CompleteSliceVerificationPayloadSchema>

export const CompleteMilestoneVerificationPayloadSchema = Type.Object(
  {
    verificationId: Type.String({ minLength: 1, maxLength: 128 }),
    scopeId: Type.String({ minLength: 1, maxLength: 128 }),
    verdict: Type.Unknown()
  },
  { additionalProperties: false }
)

export type CompleteMilestoneVerificationPayload = Static<typeof CompleteMilestoneVerificationPayloadSchema>

export const ReportNoProgressPayloadSchema = Type.Object(
  {
    decisionKey: Type.String({ minLength: 1, maxLength: 256 }),
    observedRevision: Type.Integer({ minimum: 1 }),
    workIdentity: Type.String({ minLength: 1, maxLength: 256 })
  },
  { additionalProperties: false }
)

export type ReportNoProgressPayload = Static<typeof ReportNoProgressPayloadSchema>

export const RuntimeStartedPayloadSchema = Type.Object(
  {
    runtimeInstanceId: Type.String({ minLength: 1, maxLength: 128 }),
    provider: Type.String({ minLength: 1, maxLength: 128 }),
    pidOrHandleRef: Type.Optional(Type.String({ maxLength: 256 }))
  },
  { additionalProperties: false }
)

export type RuntimeStartedPayload = Static<typeof RuntimeStartedPayloadSchema>

export const RuntimeExitedPayloadSchema = Type.Object(
  {
    runtimeInstanceId: Type.String({ minLength: 1, maxLength: 128 }),
    exitKind: Type.Union([
      Type.Literal('normal'),
      Type.Literal('error'),
      Type.Literal('signal'),
      Type.Literal('timeout')
    ]),
    exitCode: Type.Optional(Type.Integer()),
    signal: Type.Optional(Type.String({ maxLength: 32 }))
  },
  { additionalProperties: false }
)

export type RuntimeExitedPayload = Static<typeof RuntimeExitedPayloadSchema>

export const RunInterruptedPayloadSchema = Type.Object(
  {
    reason: Type.String({ minLength: 1, maxLength: 128 })
  },
  { additionalProperties: false }
)

export type RunInterruptedPayload = Static<typeof RunInterruptedPayloadSchema>

export interface JobCommandResponse {
  readonly job: {
    readonly id: string
    readonly state: string
    readonly stateRevision: number
  }
}

export interface CancelJobResponse extends JobCommandResponse {
  readonly runIdToStop: string | null
}

export interface CheckpointResult {
  readonly revision: number
  readonly mustPause: boolean
}

export interface RuntimeStartedResult {
  readonly runtimeInstanceId: string
  readonly runState: string
  readonly revision: number
}

export interface RuntimeExitResult {
  readonly decision: 'retry_scheduled' | 'job_failed' | 'pause_settled' | 'cancelled_cleanup_only' | 'stale_ignored'
  readonly newAttemptId?: string
  readonly failureId?: string
}

export interface StartVerificationResult {
  readonly verificationId: string
  readonly state: string
}

export interface VerificationResult {
  readonly verificationId: string
  readonly state: string
  readonly revision: number
}

export interface NoProgressResult {
  readonly revision: number
  readonly eventCount: number
}

export interface JobCommandService {
  requestPause(input: UserCommandEnvelope): Promise<JobCommandResponse>
  continueJob(input: UserCommandEnvelope): Promise<JobCommandResponse>
  cancelJob(input: PayloadCommandEnvelope<CancelJobPayload>): Promise<CancelJobResponse>
  restartExecution(input: PayloadCommandEnvelope<RestartExecutionPayload>): Promise<JobCommandResponse>
  acknowledgePause(input: WorkerCommandEnvelope<PauseAcknowledgedPayload>): Promise<void>
  completeExecution(input: WorkerCommandEnvelope<Record<string, never>>): Promise<void>
  checkpointTask(input: WorkerCommandEnvelope<TaskCheckpointPayload>): Promise<CheckpointResult>
  failPauseCheckpoint(input: WorkerCommandEnvelope<{ reason: string }>): Promise<void>
  interruptRun(input: WorkerCommandEnvelope<RunInterruptedPayload>): Promise<void>
  reportNoProgress(input: WorkerCommandEnvelope<ReportNoProgressPayload>): Promise<NoProgressResult>

  /**
   * PR7 Reserved: BeginWorkspaceApply
   *
   * Transitions succeeded job to applying_changes for workspace writeback.
   * Currently rejected - PR7 will implement when isolated_workspace_v1
   * capability is enabled and valid attempt/writeback intent exists.
   *
   * beginWorkspaceApply(input: PayloadCommandEnvelope<BeginWorkspaceApplyPayload>): Promise<JobCommandResponse>
   */
}

export interface InternalExecutionCommandService {
  runtimeStarted(input: WorkerCommandEnvelope<RuntimeStartedPayload>): RuntimeStartedResult
  runtimeExited(input: WorkerCommandEnvelope<RuntimeExitedPayload>): RuntimeExitResult
  startVerification(input: WorkerCommandEnvelope<StartVerificationPayload>): StartVerificationResult
  completeSliceVerification(input: WorkerCommandEnvelope<CompleteSliceVerificationPayload>): VerificationResult
  completeMilestoneVerification(input: WorkerCommandEnvelope<CompleteMilestoneVerificationPayload>): VerificationResult
  reportNoProgress(input: WorkerCommandEnvelope<ReportNoProgressPayload>): NoProgressResult
}
