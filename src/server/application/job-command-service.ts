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
  JobCommandResponse,
  CancelJobResponse,
  CheckpointResult
} from '@shared/contracts/control-plane'
import type { JobState } from '@shared/contracts/control-plane'
import type { JobRepository } from './ports/job-repository'
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
import { fromTransitionError } from '../domain/jobs/job-errors'
import { validateTaskResult } from '../domain/tasks/validate-task-result'
import { hashCanonicalCommand, canonicalJson, type JsonValue } from './utils/canonical-json'

export type JobCommandServiceDeps = {
  readonly jobRepository: JobRepository
  readonly taskRepository: TaskRepository
  readonly evidenceRepository: EvidenceStore
  readonly clock: Clock
  readonly idGenerator: IdGenerator
  readonly logger: SafeLogger
  readonly runtimeController: RuntimeController
}

export class JobCommandServiceImpl implements JobCommandService {
  private readonly jobRepository: JobRepository
  private readonly taskRepository: TaskRepository
  private readonly evidenceRepository: EvidenceStore
  private readonly clock: Clock
  private readonly idGenerator: IdGenerator
  private readonly logger: SafeLogger
  private readonly runtimeController: RuntimeController

  constructor(deps: JobCommandServiceDeps) {
    this.jobRepository = deps.jobRepository
    this.taskRepository = deps.taskRepository
    this.evidenceRepository = deps.evidenceRepository
    this.clock = deps.clock
    this.idGenerator = deps.idGenerator
    this.logger = deps.logger
    this.runtimeController = deps.runtimeController
    void this.idGenerator
  }

  async requestPause(input: UserCommandEnvelope): Promise<JobCommandResponse> {
    const requestHash = hashCanonicalCommand('request_pause', null)

    const result = this.jobRepository.transaction(() => {
      const replay = this.jobRepository.getDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey
      })
      if (replay !== null) {
        return this.assertMatchingReplay(replay, requestHash)
      }

      const job = this.jobRepository.getOwnedAggregate({
        actor: input.actor,
        jobId: input.jobId
      })
      if (job === null) throw new Error('job.not_found')
      if (job.stateRevision !== input.expectedRevision) {
        throw new Error('job.revision_conflict')
      }

      const transition = requestPause(job)
      if (!transition.ok) throw fromTransitionError(transition.error)

      const nextActiveRunId = transition.value.clearActiveRun ? null : job.activeRunId
      const cas = this.jobRepository.compareAndSetJob({
        jobId: job.id,
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
      if (!cas.ok) throw new Error('job.revision_conflict')

      if (job.activeRunId !== null && transition.value.nextState === 'pausing') {
        this.jobRepository.markRunState(job.activeRunId, 'pausing')
      }

      const response: JobCommandResponse = {
        job: {
          id: job.id,
          state: transition.value.nextState,
          stateRevision: cas.newRevision
        }
      }

      this.jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state']
        }
      })

      this.jobRepository.storeDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey,
        commandType: 'request_pause',
        requestHash,
        response,
        responseRevision: cas.newRevision
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

    return this.jobRepository.transaction(() => {
      const replay = this.jobRepository.getDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey
      })
      if (replay !== null) {
        return this.assertMatchingReplay(replay, requestHash)
      }

      const job = this.jobRepository.getOwnedAggregate({
        actor: input.actor,
        jobId: input.jobId
      })
      if (job === null) throw new Error('job.not_found')
      if (job.stateRevision !== input.expectedRevision) {
        throw new Error('job.revision_conflict')
      }

      const transition = continueJobTransition(job)
      if (!transition.ok) throw fromTransitionError(transition.error)

      const cas = this.jobRepository.compareAndSetJob({
        jobId: job.id,
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
      if (!cas.ok) throw new Error('job.revision_conflict')

      const response: JobCommandResponse = {
        job: {
          id: job.id,
          state: transition.value.nextState,
          stateRevision: cas.newRevision
        }
      }

      this.jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state']
        }
      })

      this.jobRepository.storeDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey,
        commandType: 'continue_job',
        requestHash,
        response,
        responseRevision: cas.newRevision
      })

      return response
    })
  }

  async cancelJob(input: PayloadCommandEnvelope<CancelJobPayload>): Promise<CancelJobResponse> {
    const requestHash = hashCanonicalCommand('cancel_job', input.payload)

    const result = this.jobRepository.transaction(() => {
      const replay = this.jobRepository.getDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey
      })
      if (replay !== null) {
        const stored = this.assertMatchingReplay(replay, requestHash)
        const parsed = JSON.parse(replay.responseJson) as CancelJobResponse
        return { job: stored.job, runIdToStop: parsed.runIdToStop ?? null }
      }

      const job = this.jobRepository.getOwnedAggregate({
        actor: input.actor,
        jobId: input.jobId
      })
      if (job === null) throw new Error('job.not_found')
      if (job.stateRevision !== input.expectedRevision) {
        throw new Error('job.revision_conflict')
      }

      const transition = cancelJobTransition(job)
      if (!transition.ok) throw fromTransitionError(transition.error)

      const runIdToStop = job.activeRunId
      const cas = this.jobRepository.compareAndSetJob({
        jobId: job.id,
        expectedRevision: input.expectedRevision,
        expectedState: job.state,
        expectedActiveRunId: job.activeRunId,
        next: {
          state: 'cancelled',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: job.lastFailureId,
          terminalAtMs: this.clock.nowMs()
        }
      })
      if (!cas.ok) throw new Error('job.revision_conflict')

      if (runIdToStop !== null) {
        this.jobRepository.markRunState(runIdToStop, 'cancelling', input.payload.reasonCode)
      }

      const response: CancelJobResponse = {
        job: {
          id: job.id,
          state: 'cancelled',
          stateRevision: cas.newRevision
        },
        runIdToStop
      }

      this.jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state']
        }
      })

      this.jobRepository.storeDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey,
        commandType: 'cancel_job',
        requestHash,
        response,
        responseRevision: cas.newRevision
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

    return this.jobRepository.transaction(() => {
      const replay = this.jobRepository.getDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey
      })
      if (replay !== null) {
        return this.assertMatchingReplay(replay, requestHash)
      }

      const job = this.jobRepository.getOwnedAggregate({
        actor: input.actor,
        jobId: input.jobId
      })
      if (job === null) throw new Error('job.not_found')
      if (job.stateRevision !== input.expectedRevision) {
        throw new Error('job.revision_conflict')
      }

      const transition = restartExecutionTransition(job)
      if (!transition.ok) throw fromTransitionError(transition.error)

      const nextGeneration = job.executionGeneration + 1
      const cas = this.jobRepository.compareAndSetJob({
        jobId: job.id,
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
      if (!cas.ok) throw new Error('job.revision_conflict')

      const response: JobCommandResponse = {
        job: {
          id: job.id,
          state: transition.value.nextState,
          stateRevision: cas.newRevision
        }
      }

      this.jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state']
        }
      })

      this.jobRepository.storeDedup({
        actorUsername: input.actor.username,
        idempotencyKey: input.idempotencyKey,
        commandType: 'restart_execution',
        requestHash,
        response,
        responseRevision: cas.newRevision
      })

      return response
    })
  }

  async acknowledgePause(input: WorkerCommandEnvelope<PauseAcknowledgedPayload>): Promise<void> {
    const runIdToClose = this.jobRepository.transaction(() => {
      const run = this.jobRepository.getActiveRunSummary(input.runId)
      if (
        run === null ||
        run.fenceToken !== input.fenceToken ||
        run.executionGeneration !== input.executionGeneration ||
        (run.state !== 'active' && run.state !== 'pausing')
      ) {
        throw new Error('job.stale_run')
      }

      const job = this.jobRepository.getOwnedAggregate({
        actor: { username: 'worker', requestId: 'ack-pause' },
        jobId: input.jobId
      })
      if (job === null) throw new Error('job.not_found')
      if (job.stateRevision !== input.expectedRevision) {
        throw new Error('job.revision_conflict')
      }
      if (job.state !== 'pausing' || job.controlIntent !== 'pause') {
        throw new Error('job.pause_ack_not_allowed')
      }
      if (job.activeRunId !== input.runId) {
        throw new Error('job.stale_run')
      }

      const cas = this.jobRepository.compareAndSetJob({
        jobId: job.id,
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
      if (!cas.ok) throw new Error('job.stale_run')

      this.jobRepository.markRunState(input.runId, 'paused')
      this.jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state']
        }
      })

      return input.runId
    })

    await this.runtimeController.closeThenRelease(runIdToClose, 'paused')
  }

  async checkpointTask(input: WorkerCommandEnvelope<TaskCheckpointPayload>): Promise<CheckpointResult> {
    return this.jobRepository.transaction(() => {
      const attempt = this.taskRepository.getRunningAttempt(input.payload.attemptId)
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
          throw new Error('task.attempt_result_conflict')
        }
        const job = this.jobRepository.getOwnedAggregate({
          actor: { username: 'worker', requestId: 'checkpoint' },
          jobId: input.jobId
        })
        if (job === null) throw new Error('job.not_found')
        return {
          revision: job.stateRevision,
          mustPause: job.state === 'pausing' && job.controlIntent === 'pause'
        }
      }

      const fence = this.jobRepository.workerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!fence.ok) throw new Error(fence.reason)

      const evidenceHash = this.evidenceRepository.putImmutable(normalized.result.evidence)
      this.taskRepository.finishAttempt(attempt.id, resultHash, evidenceHash)

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

      const job = this.jobRepository.getOwnedAggregate({
        actor: { username: 'worker', requestId: 'checkpoint' },
        jobId: input.jobId
      })
      if (job === null) throw new Error('job.not_found')

      this.jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: fence.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: fence.newRevision,
          changed: ['tasks']
        }
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
    this.jobRepository.transaction(() => {
      const fence = this.jobRepository.workerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!fence.ok) throw new Error(fence.reason)

      const job = this.jobRepository.getOwnedAggregate({
        actor: { username: 'worker', requestId: 'pause-checkpoint-failed' },
        jobId: input.jobId
      })
      if (job === null) throw new Error('job.not_found')
      if (job.state !== 'pausing' || job.controlIntent !== 'pause') {
        throw new Error('job.pause_checkpoint_fail_not_allowed')
      }

      const failureId = this.jobRepository.insertFailure({
        jobId: job.id,
        code: 'pause.checkpoint_failed',
        recoverability: 'recoverable',
        reason: input.payload.reason,
        runKind: 'execution'
      })

      const cas = this.jobRepository.compareAndSetJob({
        jobId: job.id,
        expectedRevision: fence.newRevision,
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
      if (!cas.ok) throw new Error('job.revision_conflict')

      this.jobRepository.markRunState(input.runId, 'paused', input.payload.reason)
      this.jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state', 'failure']
        }
      })
    })
  }

  async interruptRun(input: WorkerCommandEnvelope<RunInterruptedPayload>): Promise<void> {
    this.jobRepository.transaction(() => {
      const fence = this.jobRepository.workerFence({
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

      const job = this.jobRepository.getOwnedAggregate({
        actor: { username: 'worker', requestId: 'interrupt' },
        jobId: input.jobId
      })
      if (job === null) return

      if (job.state === 'pausing' && job.controlIntent === 'pause') {
        const cas = this.jobRepository.compareAndSetJob({
          jobId: job.id,
          expectedRevision: fence.newRevision,
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
          this.jobRepository.markRunState(input.runId, 'interrupted', input.payload.reason)
          this.jobRepository.appendOutbox({
            topic: `job:${job.id}`,
            eventType: 'job.changed',
            entityId: job.id,
            aggregateRevision: cas.newRevision,
            payload: {
              type: 'job.changed',
              entityId: job.id,
              revision: cas.newRevision,
              changed: ['state']
            }
          })
        }
        return
      }

      const failureId = this.jobRepository.insertFailure({
        jobId: job.id,
        code: 'run.interrupted',
        recoverability: 'recoverable',
        reason: input.payload.reason,
        runKind: null
      })

      const cas = this.jobRepository.compareAndSetJob({
        jobId: job.id,
        expectedRevision: fence.newRevision,
        expectedState: job.state as JobState,
        expectedActiveRunId: input.runId,
        next: {
          state: 'failed',
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: null,
          lastFailureId: failureId,
          terminalAtMs: this.clock.nowMs()
        }
      })
      if (cas.ok) {
        this.jobRepository.markRunState(input.runId, 'interrupted', input.payload.reason)
        this.jobRepository.appendOutbox({
          topic: `job:${job.id}`,
          eventType: 'job.changed',
          entityId: job.id,
          aggregateRevision: cas.newRevision,
          payload: {
            type: 'job.changed',
            entityId: job.id,
            revision: cas.newRevision,
            changed: ['state', 'failure']
          }
        })
      }
    })
  }

  private assertMatchingReplay(
    replay: { requestHash: string; responseJson: string },
    requestHash: string
  ): JobCommandResponse {
    if (replay.requestHash !== requestHash) {
      throw new Error('idempotency_key_reused')
    }
    return JSON.parse(replay.responseJson) as JobCommandResponse
  }
}
