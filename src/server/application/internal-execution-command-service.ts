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
import type { ControlPlaneUnitOfWork } from './ports/unit-of-work'
import type { Clock } from './ports/clock'
import type { IdGenerator } from './ports/id-generator'
import type { SafeLogger } from './ports/safe-logger'
import { canonicalJson, type JsonValue } from './utils/canonical-json'

export type InternalExecutionCommandServiceDeps = {
  readonly unitOfWork: ControlPlaneUnitOfWork
  readonly clock: Clock
  readonly idGenerator: IdGenerator
  readonly logger: SafeLogger
}

export class InternalExecutionCommandServiceImpl implements InternalExecutionCommandService {
  constructor(private readonly deps: InternalExecutionCommandServiceDeps) {}

  runtimeStarted(input: WorkerCommandEnvelope<RuntimeStartedPayload>): RuntimeStartedResult {
    const now = this.deps.clock.nowMs()
    return this.deps.unitOfWork.transaction((tx) => {
      const fence = tx.jobs.assertWorkerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!fence.ok) throw new Error(fence.reason)

      const instanceId = input.payload.runtimeInstanceId || this.deps.idGenerator.generate()
      tx.runtimes.createRuntimeInstance({
        id: instanceId,
        runId: input.runId,
        ownerBootId: 'control-plane',
        provider: input.payload.provider,
        pidOrHandleRef: input.payload.pidOrHandleRef,
        startedAtMs: now
      })
      tx.runs.markRunActive({
        runId: input.runId,
        runtimeInstanceId: instanceId,
        updatedAtMs: now
      })
      const job = tx.jobs.getAggregate(input.jobId)
      if (job === null) throw new Error('job.not_found')
      const cas = tx.jobs.compareAndSetJob({
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

      tx.outbox.appendOutbox({
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
    return this.deps.unitOfWork.transaction((tx) => {
      const job = tx.jobs.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) {
        const fallback = tx.jobs.getAggregate(input.jobId)
        if (fallback === null) return { decision: 'stale_ignored' }
        const run = tx.runs.getActiveRunSummary(input.runId)
        if (
          run !== null &&
          run.fenceToken === input.fenceToken &&
          run.executionGeneration === input.executionGeneration
        ) {
          tx.runtimes.closeRuntimeInstance({
            id: input.payload.runtimeInstanceId,
            runId: input.runId,
            closedAtMs: now,
            exitKind: input.payload.exitKind,
            exitCode: input.payload.exitCode,
            signal: input.payload.signal
          })
          tx.runs.markRunState({
            runId: input.runId,
            state: fallback.state === 'cancelled' ? 'cancelled' : run.state,
            stopReason: input.payload.exitKind,
            updatedAtMs: now
          })
          tx.slots.releaseSlot({ runId: input.runId, releasedAtMs: now })
          if (fallback.state === 'cancelled') {
            return { decision: 'cancelled_cleanup_only' }
          }
        }
        return { decision: 'stale_ignored' }
      }

      if (job.activeRunId !== null && job.activeRunId !== input.runId) {
        return { decision: 'stale_ignored' }
      }

      if (job.state === 'cancelled') {
        tx.runtimes.closeRuntimeInstance({
          id: input.payload.runtimeInstanceId,
          runId: input.runId,
          closedAtMs: now,
          exitKind: input.payload.exitKind,
          exitCode: input.payload.exitCode,
          signal: input.payload.signal
        })
        tx.runs.markRunState({
          runId: input.runId,
          state: 'cancelled',
          stopReason: input.payload.exitKind,
          updatedAtMs: now
        })
        tx.slots.releaseSlot({ runId: input.runId, releasedAtMs: now })
        return { decision: 'cancelled_cleanup_only' }
      }

      if (job.state === 'paused') {
        tx.runtimes.closeRuntimeInstance({
          id: input.payload.runtimeInstanceId,
          runId: input.runId,
          closedAtMs: now,
          exitKind: input.payload.exitKind,
          exitCode: input.payload.exitCode,
          signal: input.payload.signal
        })
        tx.runs.markRunState({
          runId: input.runId,
          state: 'paused',
          stopReason: input.payload.exitKind,
          updatedAtMs: now
        })
        tx.slots.releaseSlot({ runId: input.runId, releasedAtMs: now })
        return { decision: 'pause_settled' }
      }

      const fence = tx.jobs.assertWorkerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!fence.ok) return { decision: 'stale_ignored' }

      if (job.state === 'pausing' && job.controlIntent === 'pause') {
        const cas = tx.jobs.compareAndSetJob({
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
        tx.runs.markRunState({
          runId: input.runId,
          state: 'paused',
          stopReason: input.payload.exitKind,
          updatedAtMs: now
        })
        tx.runtimes.closeRuntimeInstance({
          id: input.payload.runtimeInstanceId,
          runId: input.runId,
          closedAtMs: now,
          exitKind: input.payload.exitKind,
          exitCode: input.payload.exitCode,
          signal: input.payload.signal
        })
        tx.outbox.appendOutbox({
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
        tx.slots.releaseSlot({ runId: input.runId, releasedAtMs: now })
        return { decision: 'pause_settled' }
      }

      const failureId = this.deps.idGenerator.generate()
      tx.jobs.insertFailure({
        id: failureId,
        jobId: job.id,
        code: 'runtime.exited',
        recoverability: 'recoverable',
        reason: input.payload.exitKind,
        runKind: null,
        createdAtMs: now
      })

      const cas = tx.jobs.compareAndSetJob({
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

      tx.runs.markRunState({
        runId: input.runId,
        state: 'failed',
        stopReason: input.payload.exitKind,
        updatedAtMs: now
      })
      tx.runtimes.closeRuntimeInstance({
        id: input.payload.runtimeInstanceId,
        runId: input.runId,
        closedAtMs: now,
        exitKind: input.payload.exitKind,
        exitCode: input.payload.exitCode,
        signal: input.payload.signal
      })
      tx.outbox.appendOutbox({
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
      tx.slots.releaseSlot({ runId: input.runId, releasedAtMs: now })

      return { decision: 'job_failed', failureId }
    })
  }

  startVerification(input: WorkerCommandEnvelope<StartVerificationPayload>): StartVerificationResult {
    const now = this.deps.clock.nowMs()
    return this.deps.unitOfWork.transaction((tx) => {
      const fence = tx.jobs.workerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration,
        updatedAtMs: now
      })
      if (!fence.ok) throw new Error(fence.reason)

      const job = tx.jobs.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) throw new Error('job.not_found')

      const verificationId = this.deps.idGenerator.generate()
      tx.verifications.create({
        id: verificationId,
        jobId: input.jobId,
        executionGeneration: input.executionGeneration,
        planRevision: job.currentPlanRevision ?? 1,
        scopeType: input.payload.scopeType,
        scopeId: input.payload.scopeId,
        attemptNo: 1,
        runId: input.runId,
        fenceToken: input.fenceToken,
        startedAtMs: now
      })

      tx.outbox.appendOutbox({
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
    return this.deps.unitOfWork.transaction((tx) => {
      const count = 1

      const fence = tx.jobs.assertWorkerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (!fence.ok) {
        return { revision: input.expectedRevision, eventCount: count }
      }

      const job = tx.jobs.getWorkerAggregate({
        jobId: input.jobId,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration
      })
      if (job === null) {
        return { revision: input.expectedRevision, eventCount: count }
      }

      const failureId = this.deps.idGenerator.generate()
      tx.jobs.insertFailure({
        id: failureId,
        jobId: job.id,
        code: 'workflow.no_progress',
        recoverability: 'recoverable',
        reason: input.payload.workIdentity,
        runKind: null,
        createdAtMs: now
      })

      const cas = tx.jobs.compareAndSetJob({
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

      tx.runs.markRunState({
        runId: input.runId,
        state: 'failed',
        stopReason: 'workflow.no_progress',
        updatedAtMs: now
      })

      tx.outbox.appendOutbox({
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
    return this.deps.unitOfWork.transaction((tx) => {
      const verification = tx.verifications.getById(input.payload.verificationId)
      if (verification === null) throw new Error('verification.not_found')
      if (
        verification.jobId !== input.jobId ||
        verification.executionGeneration !== input.executionGeneration ||
        verification.scopeType !== scopeType ||
        verification.scopeId !== input.payload.scopeId
      ) {
        throw new Error('verification.scope_mismatch')
      }

      const resultHash = createHash('sha256')
        .update(canonicalJson(input.payload.verdict as JsonValue))
        .digest('hex')

      if (verification.state === 'passed') {
        if (verification.resultHash !== resultHash) {
          throw new Error('verification.result_conflict')
        }
        if (verification.verdictBlobHash === null || verification.resultRevision === null) {
          throw new Error('verification.passed_without_verdict')
        }
        return {
          verificationId: verification.id,
          state: 'passed',
          revision: verification.resultRevision
        }
      }

      if (verification.state !== 'running') {
        throw new Error('verification.not_running')
      }

      const fence = tx.jobs.workerFence({
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        runId: input.runId,
        fenceToken: input.fenceToken,
        executionGeneration: input.executionGeneration,
        updatedAtMs: now
      })
      if (!fence.ok) throw new Error(fence.reason)

      const verdictBlobHash = tx.evidence.putVerdictBlob(input.payload.verdict, now)
      const marked = tx.verifications.markPassed(
        verification.id,
        verdictBlobHash,
        resultHash,
        fence.newRevision,
        now
      )
      if (!marked) throw new Error('verification.mark_failed')

      tx.outbox.appendOutbox({
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
        verificationId: verification.id,
        state: 'passed',
        revision: fence.newRevision
      }
    })
  }
}
