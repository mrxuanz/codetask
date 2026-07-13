import { createHash } from 'crypto'
import type {
  JobCommandService,
  UserCommandEnvelope,
  PayloadCommandEnvelope,
  WorkerCommandEnvelope,
  CancelJobPayload,
  RestartExecutionPayload,
  PauseAcknowledgedPayload,
  TaskCheckpointPayload,
  RunInterruptedPayload,
  ReportNoProgressPayload,
  JobCommandResponse,
  CancelJobResponse,
  CheckpointResult,
  NoProgressResult
} from '@shared/contracts/control-plane'
import type { JobState } from '@shared/contracts/control-plane'
import type { JobRepository } from './ports/job-repository'
import type { ControlPlaneUnitOfWork } from './ports/unit-of-work'
import type { TaskRepository } from './ports/task-repository'
import type { Clock } from './ports/clock'
import type { IdGenerator } from './ports/id-generator'
import type { SafeLogger } from './ports/safe-logger'
import type { EvidenceStore } from './ports/evidence-store'
import type { RuntimeController } from './ports/runtime-controller'
import {
  requestPause,
  continueJob as continueJobTransition,
  cancelJob as cancelJobTransition,
  restartExecution as restartExecutionTransition
} from '../domain/jobs/job-state-machine'
import { commandError, fromTransitionError } from '../domain/jobs/job-errors'
import { validateTaskResult } from '../domain/tasks/validate-task-result'
import { hashCanonicalCommand, canonicalJson, type JsonValue } from './utils/canonical-json'

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000

export type JobCommandServiceDeps = {
  readonly jobRepository: JobRepository
  readonly unitOfWork?: ControlPlaneUnitOfWork
  readonly taskRepository: TaskRepository
  readonly evidenceRepository: EvidenceStore
  readonly clock: Clock
  readonly idGenerator: IdGenerator
  readonly logger: SafeLogger
  readonly runtimeController: RuntimeController
}

export class JobCommandServiceImpl implements JobCommandService {
  private readonly unitOfWork: ControlPlaneUnitOfWork
  private readonly taskRepository: TaskRepository
  private readonly evidenceRepository: EvidenceStore
  private readonly clock: Clock
  private readonly idGenerator: IdGenerator
  private readonly logger: SafeLogger
  private readonly runtimeController: RuntimeController

  constructor(deps: JobCommandServiceDeps) {
    this.unitOfWork = deps.unitOfWork ?? deps.jobRepository
    this.taskRepository = deps.taskRepository
    this.evidenceRepository = deps.evidenceRepository
    this.clock = deps.clock
    this.idGenerator = deps.idGenerator
    this.logger = deps.logger
    this.runtimeController = deps.runtimeController
  }

  async requestPause(input: UserCommandEnvelope): Promise<JobCommandResponse> {
    const requestHash = hashCanonicalCommand('request_pause', null)
    const now = this.clock.nowMs()

    const result = this.unitOfWork.transaction((tx) => {
      const jobRepository = tx.jobs
      const replay = jobRepository.getDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey
      })
      if (replay !== null) {
        return this.assertMatchingReplay(replay, requestHash)
      }

      const job = jobRepository.getOwnedAggregate({
        actor: input.actor,
        jobId: input.jobId
      })
      if (job === null) throw commandError('job.not_found')
      if (job.stateRevision !== input.expectedRevision) {
        throw commandError('job.revision_conflict')
      }

      const transition = requestPause(job)
      if (!transition.ok) throw fromTransitionError(transition.error)

      const nextActiveRunId = transition.value.clearActiveRun ? null : job.activeRunId
      const cas = jobRepository.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: input.expectedRevision,
        expectedState: job.state,
        expectedActiveRunId: job.activeRunId,
        next: {
          state: transition.value.nextState,
          controlIntent: transition.value.controlIntent,
          resumeTarget: transition.value.resumeTarget,
          activeRunId: nextActiveRunId,
          lastFailureId: job.lastFailureId,
          terminalAtMs: null
        }
      })
      if (!cas.ok) throw commandError('job.revision_conflict')

      if (job.activeRunId !== null && transition.value.nextState === 'pausing') {
        jobRepository.markRunState({
          runId: job.activeRunId,
          state: 'pausing',
          updatedAtMs: now
        })
      }

      const response: JobCommandResponse = {
        job: {
          id: job.id,
          state: transition.value.nextState,
          stateRevision: cas.newRevision
        }
      }

      jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state']
        },
        createdAtMs: now
      })

      jobRepository.storeDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey,
        commandType: 'request_pause',
        requestHash,
        response,
        responseRevision: cas.newRevision,
        createdAtMs: now,
        expiresAtMs: now + DEDUP_TTL_MS
      })

      return response
    })

    try {
      this.runtimeController.notifyPauseRequested(input.jobId)
    } catch (error: unknown) {
      this.logger.warn('notifyPauseRequested failed', {
        jobId: input.jobId,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    return result
  }

  async continueJob(input: UserCommandEnvelope): Promise<JobCommandResponse> {
    const requestHash = hashCanonicalCommand('continue_job', null)
    const now = this.clock.nowMs()

    return this.unitOfWork.transaction((tx) => {
      const jobRepository = tx.jobs
      const replay = jobRepository.getDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey
      })
      if (replay !== null) {
        return this.assertMatchingReplay(replay, requestHash)
      }

      const job = jobRepository.getOwnedAggregate({
        actor: input.actor,
        jobId: input.jobId
      })
      if (job === null) throw commandError('job.not_found')
      if (job.stateRevision !== input.expectedRevision) {
        throw commandError('job.revision_conflict')
      }

      const transition = continueJobTransition(job)
      if (!transition.ok) throw fromTransitionError(transition.error)

      const cas = jobRepository.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: input.expectedRevision,
        expectedState: job.state,
        expectedActiveRunId: job.activeRunId,
        next: {
          state: transition.value.nextState,
          controlIntent: transition.value.controlIntent,
          resumeTarget: transition.value.resumeTarget,
          activeRunId: null,
          lastFailureId: job.lastFailureId,
          terminalAtMs: null
        }
      })
      if (!cas.ok) throw commandError('job.revision_conflict')

      const response: JobCommandResponse = {
        job: {
          id: job.id,
          state: transition.value.nextState,
          stateRevision: cas.newRevision
        }
      }

      jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state']
        },
        createdAtMs: now
      })

      jobRepository.storeDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey,
        commandType: 'continue_job',
        requestHash,
        response,
        responseRevision: cas.newRevision,
        createdAtMs: now,
        expiresAtMs: now + DEDUP_TTL_MS
      })

      return response
    })
  }

  async cancelJob(input: PayloadCommandEnvelope<CancelJobPayload>): Promise<CancelJobResponse> {
    const requestHash = hashCanonicalCommand('cancel_job', input.payload)
    const now = this.clock.nowMs()

    const result = this.unitOfWork.transaction((tx) => {
      const jobRepository = tx.jobs
      const replay = jobRepository.getDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey
      })
      if (replay !== null) {
        const stored = this.assertMatchingReplay(replay, requestHash)
        const parsed = JSON.parse(replay.responseJson) as CancelJobResponse
        return { job: stored.job, runIdToStop: parsed.runIdToStop ?? null }
      }

      const job = jobRepository.getOwnedAggregate({
        actor: input.actor,
        jobId: input.jobId
      })
      if (job === null) throw commandError('job.not_found')
      if (job.stateRevision !== input.expectedRevision) {
        throw commandError('job.revision_conflict')
      }

      const transition = cancelJobTransition(job)
      if (!transition.ok) throw fromTransitionError(transition.error)

      const runIdToStop = job.activeRunId
      const cas = jobRepository.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: input.expectedRevision,
        expectedState: job.state,
        expectedActiveRunId: job.activeRunId,
        next: {
          state: 'cancelled',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: job.lastFailureId,
          terminalAtMs: now
        }
      })
      if (!cas.ok) throw commandError('job.revision_conflict')

      if (runIdToStop !== null) {
        jobRepository.markRunState({
          runId: runIdToStop,
          state: 'cancelling',
          stopReason: input.payload.reasonCode,
          updatedAtMs: now
        })
      }

      const response: CancelJobResponse = {
        job: {
          id: job.id,
          state: 'cancelled',
          stateRevision: cas.newRevision
        },
        runIdToStop
      }

      jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state']
        },
        createdAtMs: now
      })

      jobRepository.storeDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey,
        commandType: 'cancel_job',
        requestHash,
        response,
        responseRevision: cas.newRevision,
        createdAtMs: now,
        expiresAtMs: now + DEDUP_TTL_MS
      })

      return response
    })

    if (result.runIdToStop !== null) {
      void this.runtimeController
        .closeThenRelease(result.runIdToStop, 'user_cancelled')
        .catch((error: unknown) => {
          this.logger.error('Runtime stop after cancel failed', {
            runId: result.runIdToStop,
            error: error instanceof Error ? error.message : String(error)
          })
        })
    }

    return result
  }

  async restartExecution(
    input: PayloadCommandEnvelope<RestartExecutionPayload>
  ): Promise<JobCommandResponse> {
    const requestHash = hashCanonicalCommand('restart_execution', input.payload)
    const now = this.clock.nowMs()

    return this.unitOfWork.transaction((tx) => {
      const jobRepository = tx.jobs
      const replay = jobRepository.getDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey
      })
      if (replay !== null) {
        return this.assertMatchingReplay(replay, requestHash)
      }

      const job = jobRepository.getOwnedAggregate({
        actor: input.actor,
        jobId: input.jobId
      })
      if (job === null) throw commandError('job.not_found')
      if (job.stateRevision !== input.expectedRevision) {
        throw commandError('job.revision_conflict')
      }

      const transition = restartExecutionTransition(job)
      if (!transition.ok) throw fromTransitionError(transition.error)

      const nextGeneration = job.executionGeneration + 1
      const cas = jobRepository.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: input.expectedRevision,
        expectedState: job.state,
        expectedActiveRunId: job.activeRunId,
        next: {
          state: transition.value.nextState,
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: job.lastFailureId,
          terminalAtMs: null,
          executionGeneration: nextGeneration
        }
      })
      if (!cas.ok) throw commandError('job.revision_conflict')
      // Restart deliberately creates a new immutable task projection. A
      // Continue command never calls this path: it resumes the same
      // generation and retains its passed verification records.
      this.taskRepository.cloneTasksToGeneration(
        job.id,
        job.executionGeneration,
        nextGeneration,
        now
      )

      const response: JobCommandResponse = {
        job: {
          id: job.id,
          state: transition.value.nextState,
          stateRevision: cas.newRevision
        }
      }

      jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state']
        },
        createdAtMs: now
      })

      jobRepository.storeDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey,
        commandType: 'restart_execution',
        requestHash,
        response,
        responseRevision: cas.newRevision,
        createdAtMs: now,
        expiresAtMs: now + DEDUP_TTL_MS
      })

      return response
    })
  }

  async acknowledgePause(input: WorkerCommandEnvelope<PauseAcknowledgedPayload>): Promise<void> {
    const now = this.clock.nowMs()
    const runIdToClose = this.unitOfWork.transaction((tx) => {
      const jobRepository = tx.jobs
      const run = jobRepository.getActiveRunSummary(input.runId)
      if (
        run === null ||
        run.fenceToken !== input.fenceToken ||
        run.executionGeneration !== input.executionGeneration ||
        (run.state !== 'active' && run.state !== 'pausing')
      ) {
        throw new Error('job.stale_run')
      }

      const job = jobRepository.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) throw commandError('job.not_found')
      if (job.stateRevision !== input.expectedRevision) {
        throw commandError('job.revision_conflict')
      }
      if (job.state !== 'pausing' || job.controlIntent !== 'pause') {
        throw new Error('job.pause_ack_not_allowed')
      }
      if (job.activeRunId !== input.runId) {
        throw new Error('job.stale_run')
      }

      const cas = jobRepository.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: input.expectedRevision,
        expectedState: 'pausing',
        expectedActiveRunId: input.runId,
        next: {
          state: 'paused',
          controlIntent: 'none',
          resumeTarget: job.resumeTarget,
          activeRunId: null,
          lastFailureId: job.lastFailureId,
          terminalAtMs: null
        }
      })
      if (!cas.ok) throw commandError('job.stale_run')

      jobRepository.markRunState({
        runId: input.runId,
        state: 'paused',
        updatedAtMs: now
      })
      jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state']
        },
        createdAtMs: now
      })

      return input.runId
    })

    await this.runtimeController.closeThenRelease(runIdToClose, 'paused')
  }

  async completeExecution(input: WorkerCommandEnvelope<Record<string, never>>): Promise<void> {
    const now = this.clock.nowMs()
    this.unitOfWork.transaction((tx) => {
      const jobRepository = tx.jobs
      const fence = jobRepository.assertWorkerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!fence.ok) throw commandError(fence.reason)

      const job = jobRepository.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) throw commandError('job.not_found')
      if (job.state !== 'execution_running' || job.controlIntent !== 'none') {
        throw new Error('job.complete_not_allowed')
      }

      const cas = jobRepository.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: input.expectedRevision,
        expectedState: 'execution_running',
        expectedActiveRunId: input.runId,
        next: {
          state: 'succeeded',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: job.lastFailureId,
          terminalAtMs: now
        }
      })
      if (!cas.ok) throw commandError('job.stale_run')

      jobRepository.markRunState({
        runId: input.runId,
        state: 'succeeded',
        updatedAtMs: now
      })
      jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state']
        },
        createdAtMs: now
      })
    })
  }

  async checkpointTask(input: WorkerCommandEnvelope<TaskCheckpointPayload>): Promise<CheckpointResult> {
    const now = this.clock.nowMs()
    return this.unitOfWork.transaction((tx) => {
      const jobRepository = tx.jobs
      const attempt = this.taskRepository.getAttempt(input.payload.attemptId)
      if (attempt === null) throw new Error('task.attempt_not_running')
      if (attempt.runId !== input.runId || attempt.jobId !== input.jobId) {
        throw new Error('task.attempt_fence_mismatch')
      }
      if (attempt.executionGeneration !== input.executionGeneration) {
        throw new Error('task.attempt_generation_mismatch')
      }

      const normalized = validateTaskResult(input.payload.result)
      const resultHash = createHash('sha256')
        .update(canonicalJson(JSON.parse(JSON.stringify(normalized.result)) as JsonValue))
        .digest('hex')

      if (attempt.resultHash !== null) {
        if (attempt.resultHash !== resultHash) {
          throw commandError('task.attempt_result_conflict')
        }
        const job = jobRepository.getWorkerAggregate({
          jobId: input.jobId,
          runId: input.runId,
          fenceToken: input.fenceToken,
          executionGeneration: input.executionGeneration
        })
        if (job === null) throw commandError('job.not_found')
        if (attempt.resultRevision === null) {
          throw new Error('task.attempt_result_revision_missing')
        }
        return {
          revision: attempt.resultRevision,
          mustPause: job.state === 'pausing' && job.controlIntent === 'pause'
        }
      }

      if (attempt.state !== 'running') throw new Error('task.attempt_not_running')
      const assertion = jobRepository.assertWorkerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!assertion.ok) throw commandError(assertion.reason)

      const fence = jobRepository.workerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration,
        updatedAtMs: now
      })
      if (!fence.ok) throw commandError(fence.reason)

      const evidenceHash = this.evidenceRepository.putImmutable(normalized.result.evidence)
      this.taskRepository.finishAttempt(attempt.id, resultHash, evidenceHash, fence.newRevision)

      const current = this.taskRepository.getCurrentTask(
        attempt.jobId,
        attempt.executionGeneration,
        attempt.taskId
      )
      if (current === null) throw new Error('task.not_found')
      const updated = this.taskRepository.updateTaskState(
        attempt.jobId,
        attempt.executionGeneration,
        attempt.taskId,
        current.state,
        normalized.taskState
      )
      if (!updated) throw new Error('task.state_conflict')

      const job = jobRepository.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) throw commandError('job.not_found')

      jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: fence.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: fence.newRevision,
          changed: ['tasks']
        },
        createdAtMs: now
      })

      return {
        revision: fence.newRevision,
        mustPause: job.state === 'pausing' && job.controlIntent === 'pause'
      }
    })
  }

  async failPauseCheckpoint(
    input: WorkerCommandEnvelope<{ reason: string }>
  ): Promise<void> {
    const now = this.clock.nowMs()
    this.unitOfWork.transaction((tx) => {
      const jobRepository = tx.jobs
      const fence = jobRepository.assertWorkerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!fence.ok) throw commandError(fence.reason)

      const job = jobRepository.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) throw new Error('job.not_found')
      if (job.state !== 'pausing' || job.controlIntent !== 'pause') {
        throw new Error('job.pause_checkpoint_fail_not_allowed')
      }

      const failureId = this.idGenerator.generate()
      jobRepository.insertFailure({
        id: failureId,
        jobId: job.id,
        code: 'pause.checkpoint_failed',
        recoverability: 'recoverable',
        reason: input.payload.reason,
        runKind: 'execution',
        createdAtMs: now
      })

      const cas = jobRepository.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: input.expectedRevision,
        expectedState: 'pausing',
        expectedActiveRunId: input.runId,
        next: {
          state: 'paused',
          controlIntent: 'none',
          resumeTarget: job.resumeTarget,
          activeRunId: null,
          lastFailureId: failureId,
          terminalAtMs: null
        }
      })
      if (!cas.ok) throw commandError('job.revision_conflict')

      jobRepository.markRunState({
        runId: input.runId,
        state: 'paused',
        stopReason: input.payload.reason,
        updatedAtMs: now
      })
      jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state', 'failure']
        },
        createdAtMs: now
      })
    })
  }

  async reportNoProgress(
    input: WorkerCommandEnvelope<ReportNoProgressPayload>
  ): Promise<NoProgressResult> {
    const now = this.clock.nowMs()
    return this.unitOfWork.transaction((tx) => {
      const jobRepository = tx.jobs
      const fence = jobRepository.assertWorkerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!fence.ok) return { revision: input.expectedRevision, eventCount: 1 }

      const job = jobRepository.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) return { revision: input.expectedRevision, eventCount: 1 }

      const failureId = this.idGenerator.generate()
      jobRepository.insertFailure({
        id: failureId,
        jobId: job.id,
        code: 'workflow.no_progress',
        recoverability: 'recoverable',
        reason: input.payload.workIdentity,
        runKind: 'execution',
        createdAtMs: now
      })
      const cas = jobRepository.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: input.expectedRevision,
        expectedState: job.state,
        expectedActiveRunId: input.runId,
        next: {
          state: 'failed',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: failureId,
          terminalAtMs: now
        }
      })
      if (!cas.ok) return { revision: input.expectedRevision, eventCount: 1 }

      jobRepository.markRunState({
        runId: input.runId,
        state: 'failed',
        stopReason: 'workflow.no_progress',
        updatedAtMs: now
      })
      jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state', 'failure']
        },
        createdAtMs: now
      })
      return { revision: cas.newRevision, eventCount: 1 }
    })
  }

  async interruptRun(input: WorkerCommandEnvelope<RunInterruptedPayload>): Promise<void> {
    const now = this.clock.nowMs()
    this.unitOfWork.transaction((tx) => {
      const jobRepository = tx.jobs
      const fence = jobRepository.assertWorkerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!fence.ok) {
        this.logger.info('interruptRun ignored stale fence', {
          jobId: input.jobId,
          reason: fence.reason
        })
        return
      }

      const job = jobRepository.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) return

      if (job.state === 'pausing' && job.controlIntent === 'pause') {
        const cas = jobRepository.compareAndSetJob({
          jobId: job.id,
          updatedAtMs: now,
          expectedRevision: input.expectedRevision,
          expectedState: 'pausing',
          expectedActiveRunId: input.runId,
          next: {
            state: 'paused',
            controlIntent: 'none',
            resumeTarget: job.resumeTarget,
            activeRunId: null,
            lastFailureId: job.lastFailureId,
            terminalAtMs: null
          }
        })
        if (cas.ok) {
          jobRepository.markRunState({
            runId: input.runId,
            state: 'interrupted',
            stopReason: input.payload.reason,
            updatedAtMs: now
          })
          jobRepository.appendOutbox({
            topic: `job:${job.id}`,
            eventType: 'job.changed',
            entityId: job.id,
            aggregateRevision: cas.newRevision,
            payload: {
              type: 'job.changed',
              entityId: job.id,
              revision: cas.newRevision,
              changed: ['state']
            },
            createdAtMs: now
          })
        }
        return
      }

      const failureId = this.idGenerator.generate()
      jobRepository.insertFailure({
        id: failureId,
        jobId: job.id,
        code: 'run.interrupted',
        recoverability: 'recoverable',
        reason: input.payload.reason,
        runKind: null,
        createdAtMs: now
      })

      const cas = jobRepository.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: input.expectedRevision,
        expectedState: job.state as JobState,
        expectedActiveRunId: input.runId,
        next: {
          state: 'failed',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: failureId,
          terminalAtMs: now
        }
      })
      if (cas.ok) {
        jobRepository.markRunState({
          runId: input.runId,
          state: 'interrupted',
          stopReason: input.payload.reason,
          updatedAtMs: now
        })
        jobRepository.appendOutbox({
          topic: `job:${job.id}`,
          eventType: 'job.changed',
          entityId: job.id,
          aggregateRevision: cas.newRevision,
          payload: {
            type: 'job.changed',
            entityId: job.id,
            revision: cas.newRevision,
            changed: ['state', 'failure']
          },
          createdAtMs: now
        })
      }
    })
  }

  private assertMatchingReplay(
    replay: { requestHash: string; responseJson: string },
    requestHash: string
  ): JobCommandResponse {
    if (replay.requestHash !== requestHash) {
      throw commandError('idempotency_key_reused')
    }
    return JSON.parse(replay.responseJson) as JobCommandResponse
  }
}
