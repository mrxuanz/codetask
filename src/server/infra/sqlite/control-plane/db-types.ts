import type { JobState, ControlIntent, ResumeTarget, RunKind, Recoverability } from '@shared/contracts/control-plane'

export interface ControlJobRow {
  readonly id: string
  readonly threadId: string
  readonly projectId: string
  readonly draftMessageId: string
  readonly state: JobState
  readonly stateRevision: number
  readonly controlIntent: ControlIntent
  readonly resumeTarget: ResumeTarget | null
  readonly currentPlanRevision: number | null
  readonly executionGeneration: number
  readonly activeRunId: string | null
  readonly lastFailureId: string | null
  readonly title: string
  readonly requirementsSummary: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly terminalAtMs: number | null
}

export interface ControlJobRunRow {
  readonly id: string
  readonly jobId: string
  readonly kind: RunKind
  readonly state: string
  readonly attemptNo: number
  readonly fenceToken: string
  readonly executionGeneration: number
  readonly leaseOwnerBootId: string | null
  readonly currentRuntimeInstanceId: string | null
  readonly pendingAttemptId: string | null
  readonly lifecycleOperationId: string | null
  readonly heartbeatAtMs: number | null
  readonly stopReason: string | null
  readonly startedAtMs: number
  readonly endedAtMs: number | null
}

export interface ControlRuntimeInstanceRow {
  readonly id: string
  readonly runId: string
  readonly taskAttemptId: string | null
  readonly state: string
  readonly ownerBootId: string
  readonly provider: string | null
  readonly protocolState: string | null
  readonly pidOrHandleRef: string | null
  readonly startedAtMs: number
  readonly closedAtMs: number | null
  readonly exitKind: string | null
  readonly exitCode: number | null
  readonly signal: string | null
}

export interface ControlJobTaskRow {
  readonly jobId: string
  readonly executionGeneration: number
  readonly taskId: string
  readonly sourcePlanRevision: number
  readonly state: string
  readonly sortOrder: number
  readonly originKind: string | null
  readonly parentTaskId: string | null
  readonly title: string
  readonly abilityCode: string | null
  readonly coreCode: string | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface ControlTaskAttemptRow {
  readonly id: string
  readonly jobId: string
  readonly executionGeneration: number
  readonly taskId: string
  readonly attemptNo: number
  readonly runId: string
  readonly state: string
  readonly provider: string | null
  readonly evidenceBlobHash: string | null
  readonly failureId: string | null
  readonly startedAtMs: number
  readonly endedAtMs: number | null
  readonly resultHash: string | null
  readonly resultRevision: number
}

export interface ControlVerificationRow {
  readonly id: string
  readonly jobId: string
  readonly executionGeneration: number
  readonly planRevision: number
  readonly scopeType: string
  readonly scopeId: string
  readonly attemptNo: number
  readonly state: string
  readonly runId: string | null
  readonly fenceToken: string | null
  readonly verdictBlobHash: string | null
  readonly resultHash: string | null
  readonly failureId: string | null
  readonly startedAtMs: number
  readonly endedAtMs: number | null
}

export interface ControlOutboxEventRow {
  readonly eventId: number
  readonly topic: string
  readonly eventType: string
  readonly entityId: string
  readonly aggregateRevision: number
  readonly payloadJson: string
  readonly payloadBytes: number
  readonly createdAtMs: number
  readonly dispatchedAtMs: number | null
}

export interface ControlCommandDedupRow {
  readonly actorUsername: string
  readonly idempotencyKey: string
  readonly commandType: string
  readonly requestHash: string
  readonly responseJson: string
  readonly responseRevision: number
  readonly createdAtMs: number
  readonly expiresAtMs: number
}

export interface ControlJobFailureRow {
  readonly id: string
  readonly jobId: string
  readonly code: string
  readonly recoverability: Recoverability
  readonly reason: string | null
  readonly runKind: RunKind | null
  readonly createdAtMs: number
}

export interface ControlSchemaMetaRow {
  readonly key: string
  readonly value: string
  readonly sourceMigration: number
  readonly copyReportHash: string | null
  readonly backupId: string | null
  readonly validationSummaryJson: string | null
  readonly updatedAtMs: number
}
