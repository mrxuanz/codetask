import { createHash } from 'crypto'
import type {
  InternalExecutionCommandService,
  WorkerCommandEnvelope,
  RuntimeStartedPayload,
  RuntimeStartedResult,
  RuntimeExitedPayload,
  RuntimeExitResult,
  StartVerificationPayload,
  StartVerificationResult,
  CompleteSliceVerificationPayload,
  CompleteMilestoneVerificationPayload,
  VerificationResult,
  ReportNoProgressPayload,
  NoProgressResult
} from '@shared/contracts/control-plane'
import type { JobRepository } from './ports/job-repository'
import type { Clock } from './ports/clock'
import type { IdGenerator } from './ports/id-generator'
import type { SafeLogger } from './ports/safe-logger'
import type { VerificationStore } from './ports/verification-store'
import type { EvidenceStore } from './ports/evidence-store'
import { canonicalJson, type JsonValue } from './utils/canonical-json'

export type InternalExecutionCommandServiceDeps = {
  readonly jobRepository: JobRepository
  readonly verificationRepository: VerificationStore
  readonly evidenceRepository: EvidenceStore
  readonly clock: Clock
  readonly idGenerator: IdGenerator
  readonly logger: SafeLogger
}

export class InternalExecutionCommandServiceImpl implements InternalExecutionCommandService {
  constructor(private readonly deps: InternalExecutionCommandServiceDeps) {}

  runtimeStarted(input: WorkerCommandEnvelope<RuntimeStartedPayload>): RuntimeStartedResult {
    const now = this.deps.clock.nowMs()
    return this.deps.jobRepository.transaction(() => {
      const fence = this.deps.jobRepository.assertWorkerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!fence.ok) throw new Error(fence.reason)

      const instanceId = input.payload.runtimeInstanceId || this.deps.idGenerator.generate()
      this.deps.jobRepository.createRuntimeInstance({
        id: instanceId,
        runId: input.runId,
        ownerBootId: 'control-plane',
        provider: input.payload.provider,
        pidOrHandleRef: input.payload.pidOrHandleRef,
        startedAtMs: now
      })
      this.deps.jobRepository.markRunActive({
        runId: input.runId,
        runtimeInstanceId: instanceId,
        updatedAtMs: now
      })
      const job = this.deps.jobRepository.getAggregate(input.jobId)
      if (job === null) throw new Error('job.not_found')
      const cas = this.deps.jobRepository.compareAndSetJob({
        jobId: input.jobId,
        updatedAtMs: now,
        expectedRevision: input.expectedRevision,
        expectedState: job.state,
        expectedActiveRunId: input.runId,
        next: {
          state: job.state,
          controlIntent: job.controlIntent,
          resumeTarget: job.resumeTarget,
          activeRunId: input.runId,
          lastFailureId: job.lastFailureId,
          terminalAtMs: null
        }
      })
      if (!cas.ok) throw new Error(cas.reason)

      this.deps.jobRepository.appendOutbox({
        topic: `job:${input.jobId}`,
        eventType: 'job.changed',
        entityId: input.jobId,
        aggregateRevision: cas.newRevision,
        payload: {
          type: 'job.changed',
          entityId: input.jobId,
          revision: cas.newRevision,
          changed: ['state']
        },
        createdAtMs: now
      })

      return { runtimeInstanceId: instanceId, runState: 'active', revision: cas.newRevision }
    })
  }

  runtimeExited(input: WorkerCommandEnvelope<RuntimeExitedPayload>): RuntimeExitResult {
    const now = this.deps.clock.nowMs()
    return this.deps.jobRepository.transaction(() => {
      const job = this.deps.jobRepository.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) {
        // Cancel may have cleared active_run_id; fall back to internal read.
        const fallback = this.deps.jobRepository.getAggregate(input.jobId)
        if (fallback === null) return { decision: 'stale_ignored' }
        if (fallback.state === 'cancelled' || fallback.state === 'succeeded') {
          this.deps.jobRepository.closeRuntimeInstance({
            id: input.payload.runtimeInstanceId,
            runId: input.runId,
            closedAtMs: now,
            exitKind: input.payload.exitKind,
            exitCode: input.payload.exitCode,
            signal: input.payload.signal
          })
          this.deps.jobRepository.markRunState({
            runId: input.runId,
            state: fallback.state,
            stopReason: input.payload.exitKind,
            updatedAtMs: now
          })
          return fallback.state === 'cancelled'
            ? { decision: 'cancelled_cleanup_only' }
            : { decision: 'stale_ignored' }
        }
        return { decision: 'stale_ignored' }
      }

      if (job.activeRunId !== input.runId) {
        return { decision: 'stale_ignored' }
      }

      const fence = this.deps.jobRepository.assertWorkerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!fence.ok) return { decision: 'stale_ignored' }

      if (job.state === 'cancelled') {
        this.deps.jobRepository.closeRuntimeInstance({
          id: input.payload.runtimeInstanceId,
          runId: input.runId,
          closedAtMs: now,
          exitKind: input.payload.exitKind,
          exitCode: input.payload.exitCode,
          signal: input.payload.signal
        })
        this.deps.jobRepository.markRunState({
          runId: input.runId,
          state: 'cancelled',
          stopReason: input.payload.exitKind,
          updatedAtMs: now
        })
        return { decision: 'cancelled_cleanup_only' }
      }

      if (job.state === 'pausing' && job.controlIntent === 'pause') {
        const cas = this.deps.jobRepository.compareAndSetJob({
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
        if (!cas.ok) return { decision: 'stale_ignored' }
        this.deps.jobRepository.markRunState({
          runId: input.runId,
          state: 'paused',
          stopReason: input.payload.exitKind,
          updatedAtMs: now
        })
        this.deps.jobRepository.closeRuntimeInstance({
          id: input.payload.runtimeInstanceId,
          runId: input.runId,
          closedAtMs: now,
          exitKind: input.payload.exitKind,
          exitCode: input.payload.exitCode,
          signal: input.payload.signal
        })
        this.deps.jobRepository.appendOutbox({
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
        return { decision: 'pause_settled' }
      }

      const failureId = this.deps.idGenerator.generate()
      this.deps.jobRepository.insertFailure({
        id: failureId,
        jobId: job.id,
        code: 'runtime.exited',
        recoverability: 'recoverable',
        reason: input.payload.exitKind,
        runKind: null,
        createdAtMs: now
      })

      const cas = this.deps.jobRepository.compareAndSetJob({
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
      if (!cas.ok) return { decision: 'stale_ignored' }

      this.deps.jobRepository.markRunState({
        runId: input.runId,
        state: 'failed',
        stopReason: input.payload.exitKind,
        updatedAtMs: now
      })
      this.deps.jobRepository.closeRuntimeInstance({
        id: input.payload.runtimeInstanceId,
        runId: input.runId,
        closedAtMs: now,
        exitKind: input.payload.exitKind,
        exitCode: input.payload.exitCode,
        signal: input.payload.signal
      })
      this.deps.jobRepository.appendOutbox({
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

      return { decision: 'job_failed', failureId }
    })
  }

  startVerification(input: WorkerCommandEnvelope<StartVerificationPayload>): StartVerificationResult {
    const now = this.deps.clock.nowMs()
    return this.deps.jobRepository.transaction(() => {
      const fence = this.deps.jobRepository.workerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration,
        updatedAtMs: now
      })
      if (!fence.ok) throw new Error(fence.reason)

      const job = this.deps.jobRepository.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) throw new Error('job.not_found')

      const verificationId = this.deps.verificationRepository.create({
        jobId: input.jobId,
        executionGeneration: input.executionGeneration,
        planRevision: job.currentPlanRevision ?? 1,
        scopeType: input.payload.scopeType,
        scopeId: input.payload.scopeId,
        attemptNo: 1,
        runId: input.runId,
        fenceToken: input.fenceToken
      })

      this.deps.jobRepository.appendOutbox({
        topic: `job:${input.jobId}`,
        eventType: 'job.changed',
        entityId: input.jobId,
        aggregateRevision: fence.newRevision,
        payload: {
          type: 'job.changed',
          entityId: input.jobId,
          revision: fence.newRevision,
          changed: ['state']
        },
        createdAtMs: now
      })

      return { verificationId, state: 'running' }
    })
  }

  completeSliceVerification(
    input: WorkerCommandEnvelope<CompleteSliceVerificationPayload>
  ): VerificationResult {
    return this.completeVerification(input, 'slice')
  }

  completeMilestoneVerification(
    input: WorkerCommandEnvelope<CompleteMilestoneVerificationPayload>
  ): VerificationResult {
    return this.completeVerification(input, 'milestone')
  }

  reportNoProgress(input: WorkerCommandEnvelope<ReportNoProgressPayload>): NoProgressResult {
    const now = this.deps.clock.nowMs()
    return this.deps.jobRepository.transaction(() => {
      const count = 1

      const fence = this.deps.jobRepository.assertWorkerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!fence.ok) {
        return { revision: input.expectedRevision, eventCount: count }
      }

      const job = this.deps.jobRepository.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) {
        return { revision: input.expectedRevision, eventCount: count }
      }

      const failureId = this.deps.idGenerator.generate()
      this.deps.jobRepository.insertFailure({
        id: failureId,
        jobId: job.id,
        code: 'workflow.no_progress',
        recoverability: 'recoverable',
        reason: input.payload.workIdentity,
        runKind: null,
        createdAtMs: now
      })

      const cas = this.deps.jobRepository.compareAndSetJob({
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
      if (!cas.ok) {
        return { revision: input.expectedRevision, eventCount: count }
      }

      this.deps.jobRepository.markRunState({
        runId: input.runId,
        state: 'failed',
        stopReason: 'workflow.no_progress',
        updatedAtMs: now
      })

      this.deps.jobRepository.appendOutbox({
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

      return { revision: cas.newRevision, eventCount: count }
    })
  }

  private completeVerification(
    input: WorkerCommandEnvelope<CompleteSliceVerificationPayload | CompleteMilestoneVerificationPayload>,
    scopeType: 'slice' | 'milestone'
  ): VerificationResult {
    const now = this.deps.clock.nowMs()
    return this.deps.jobRepository.transaction(() => {
      const job = this.deps.jobRepository.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) throw new Error('job.not_found')

      const resultHash = createHash('sha256')
        .update(canonicalJson(input.payload.verdict as JsonValue))
        .digest('hex')

      const existing = this.deps.verificationRepository
        .getCurrentPassedVerifications(
          input.jobId,
          input.executionGeneration,
          job.currentPlanRevision ?? 1,
          scopeType
        )
        .find((v) => v.scopeId === input.payload.scopeId)

      if (existing !== undefined && existing.resultHash === resultHash) {
        return {
          verificationId: existing.id,
          state: 'passed',
          revision: job.stateRevision
        }
      }

      const fence = this.deps.jobRepository.workerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration,
        updatedAtMs: now
      })
      if (!fence.ok) throw new Error(fence.reason)

      const verdictBlobHash = this.deps.evidenceRepository.putVerdictBlob(input.payload.verdict)
      const verificationId = this.deps.verificationRepository.create({
        jobId: input.jobId,
        executionGeneration: input.executionGeneration,
        planRevision: job.currentPlanRevision ?? 1,
        scopeType,
        scopeId: input.payload.scopeId,
        attemptNo: (existing?.attemptNo ?? 0) + 1,
        runId: input.runId,
        fenceToken: input.fenceToken
      })

      const marked = this.deps.verificationRepository.markPassed(
        verificationId,
        verdictBlobHash,
        resultHash
      )
      if (!marked) throw new Error('verification.mark_failed')

      this.deps.jobRepository.appendOutbox({
        topic: `job:${input.jobId}`,
        eventType: 'job.changed',
        entityId: input.jobId,
        aggregateRevision: fence.newRevision,
        payload: {
          type: 'job.changed',
          entityId: input.jobId,
          revision: fence.newRevision,
          changed: ['state']
        },
        createdAtMs: now
      })

      return {
        verificationId,
        state: 'passed',
        revision: fence.newRevision
      }
    })
  }
}
