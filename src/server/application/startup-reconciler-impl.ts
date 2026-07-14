import type { JobRepository, JobAggregateView } from './ports/job-repository'
import type { ControlPlaneUnitOfWork } from './ports/unit-of-work'
import type { SafeLogger } from './ports/safe-logger'
import type { Clock } from './ports/clock'
import type { IdGenerator } from './ports/id-generator'
import type { RuntimeSupervisor } from './runtime-supervisor'
import {
  decideStartupReconcile,
  type ReconcileDecision,
  type ReconcileInput,
  type InterruptionReason
} from './startup-reconciler'

const CURRENT_BOOT_ID = 'control-plane'

export class StartupReconciler {
  constructor(
    private readonly jobRepository: JobRepository,
    private readonly unitOfWork: ControlPlaneUnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly logger: SafeLogger,
    private readonly runtimeSupervisor?: RuntimeSupervisor
  ) {}

  async reconcileAll(): Promise<readonly ReconcileDecision[]> {
    const jobs = this.jobRepository.getJobsForReconciliation()
    const decisions: ReconcileDecision[] = []

    for (const job of jobs) {
      const decision = this.reconcileJob(job)
      decisions.push(decision)
    }

    this.logger.info('Startup reconciliation completed', { decisionCount: decisions.length })
    return decisions
  }

  private reconcileJob(job: JobAggregateView): ReconcileDecision {
    const activeRun = job.activeRunId
      ? this.jobRepository.getActiveRunSummary(job.activeRunId)
      : null

    const facts = this.unitOfWork.transaction((tx) => {
      const runId = job.activeRunId
      const hasActiveSlot =
        runId !== null ? tx.slots.hasActiveSlotForRun(runId) : false
      const activeRuntime =
        runId !== null ? tx.runtimes.getActiveInstanceForRun(runId) : null
      const hasRunningAttempt =
        runId !== null ? tx.verifications.hasRunningVerificationForRun(runId) : false
      const runtimeWasClosed =
        runId !== null
          ? activeRuntime === null && tx.runtimes.hasClosedInstanceForRun(runId)
          : false

      return {
        hasActiveSlot,
        hasRunningAttempt,
        hasRegisteredRuntimeInstance:
          (runId !== null && this.runtimeSupervisor?.getByRunId(runId) !== undefined) ||
          activeRuntime !== null,
        runBelongsToCurrentBoot:
          activeRuntime !== null && activeRuntime.ownerBootId === CURRENT_BOOT_ID,
        hasSupervisedLifecycleOperation: false,
        runtimeWasClosed
      }
    })

    const input: ReconcileInput = {
      job,
      runIsStale: activeRun !== null && activeRun.state !== 'active',
      interruptionReason: 'process_crash' as InterruptionReason,
      hasRunningAttempt: facts.hasRunningAttempt,
      hasLegacyActiveRuntime: facts.hasRegisteredRuntimeInstance,
      runBelongsToCurrentBoot: facts.runBelongsToCurrentBoot,
      hasActiveSlot: facts.hasActiveSlot,
      hasRegisteredRuntimeInstance: facts.hasRegisteredRuntimeInstance,
      hasSupervisedLifecycleOperation: facts.hasSupervisedLifecycleOperation,
      runtimeWasClosed: facts.runtimeWasClosed
    }

    const decision = decideStartupReconcile(input)

    this.executeDecision(job, decision)
    return decision
  }

  private executeDecision(job: JobAggregateView, decision: ReconcileDecision): void {
    switch (decision.kind) {
      case 'settle_paused':
        this.settlePaused(job, decision.failureReason)
        break
      case 'settle_interrupted_failure':
        this.settleInterruptedFailure(job, decision.reason)
        break
      case 'settle_runtime_lost':
        this.settleRuntimeLost(job, decision.reason)
        break
      case 'kill_orphan_keep_job':
        this.logger.info('Kill orphan runtime, keep job', { jobId: job.id })
        break
      case 'quarantine':
        this.logger.warn('Job quarantined', { jobId: job.id, code: decision.violationCode })
        break
      case 'no_change':
        break
    }
  }

  private settlePaused(job: JobAggregateView, failureReason: string | null): void {
    const now = this.clock.nowMs()
    this.unitOfWork.transaction((tx) => {
      const cas = tx.jobs.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: job.stateRevision,
        expectedState: job.state,
        expectedActiveRunId: job.activeRunId,
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
        tx.outbox.appendOutbox({
          topic: `job:${job.id}`,
          eventType: 'job.changed',
          entityId: job.id,
          aggregateRevision: cas.newRevision,
          payload: { type: 'job.changed', entityId: job.id, revision: cas.newRevision, changed: ['state'] },
          createdAtMs: now
        })

        if (failureReason) {
          tx.jobs.insertFailure({
            id: this.idGenerator.generate(),
            jobId: job.id,
            code: 'run.interrupted',
            recoverability: 'recoverable',
            reason: failureReason,
            runKind: null,
            createdAtMs: now
          })
        }
      }
    })
  }

  private settleInterruptedFailure(job: JobAggregateView, reason: InterruptionReason): void {
    const now = this.clock.nowMs()
    this.unitOfWork.transaction((tx) => {
      const failureId = this.idGenerator.generate()
      tx.jobs.insertFailure({
        id: failureId,
        jobId: job.id,
        code: 'run.interrupted',
        recoverability: 'recoverable',
        reason,
        runKind: null,
        createdAtMs: now
      })

      const cas = tx.jobs.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: job.stateRevision,
        expectedState: job.state,
        expectedActiveRunId: job.activeRunId,
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
        tx.outbox.appendOutbox({
          topic: `job:${job.id}`,
          eventType: 'job.changed',
          entityId: job.id,
          aggregateRevision: cas.newRevision,
          payload: { type: 'job.changed', entityId: job.id, revision: cas.newRevision, changed: ['state', 'failure'] },
          createdAtMs: now
        })
      }
    })
  }

  private settleRuntimeLost(job: JobAggregateView, reason: 'child_closed' | 'owner_missing'): void {
    const now = this.clock.nowMs()
    this.unitOfWork.transaction((tx) => {
      const failureId = this.idGenerator.generate()
      tx.jobs.insertFailure({
        id: failureId,
        jobId: job.id,
        code: 'runtime.lost',
        recoverability: 'recoverable',
        reason,
        runKind: null,
        createdAtMs: now
      })

      const cas = tx.jobs.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: job.stateRevision,
        expectedState: job.state,
        expectedActiveRunId: job.activeRunId,
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
        this.logger.warn('Runtime lost settlement raced', { jobId: job.id, reason })
        return
      }

      if (job.activeRunId !== null) {
        tx.runs.markRunState({
          runId: job.activeRunId,
          state: 'interrupted',
          stopReason: reason,
          updatedAtMs: now
        })
        tx.slots.releaseSlot({ runId: job.activeRunId, releasedAtMs: now })
      }

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
    })
  }
}
