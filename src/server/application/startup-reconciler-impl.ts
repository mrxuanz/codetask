import type { JobRepository, JobAggregateView } from './ports/job-repository'
import type { SafeLogger } from './ports/safe-logger'
import type { Clock } from './ports/clock'
import type { IdGenerator } from './ports/id-generator'
import {
  decideStartupReconcile,
  type ReconcileDecision,
  type ReconcileInput,
  type InterruptionReason
} from './startup-reconciler'

export class StartupReconciler {
  constructor(
    private readonly jobRepository: JobRepository,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly logger: SafeLogger
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

    const input: ReconcileInput = {
      job,
      runIsStale: activeRun !== null && activeRun.state !== 'active',
      interruptionReason: 'process_crash' as InterruptionReason,
      hasRunningAttempt: false,
      hasLegacyActiveRuntime: false,
      runBelongsToCurrentBoot: false,
      hasActiveSlot: activeRun !== null,
      hasRegisteredRuntimeInstance: false,
      hasSupervisedLifecycleOperation: false,
      runtimeWasClosed: false
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
    this.jobRepository.transaction(() => {
      const cas = this.jobRepository.compareAndSetJob({
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
        this.jobRepository.appendOutbox({
          topic: `job:${job.id}`,
          eventType: 'job.changed',
          entityId: job.id,
          aggregateRevision: cas.newRevision,
          payload: { type: 'job.changed', entityId: job.id, revision: cas.newRevision, changed: ['state'] },
          createdAtMs: now
        })

        if (failureReason) {
          this.jobRepository.insertFailure({
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
    this.jobRepository.transaction(() => {
      const failureId = this.idGenerator.generate()
      this.jobRepository.insertFailure({
        id: failureId,
        jobId: job.id,
        code: 'run.interrupted',
        recoverability: 'recoverable',
        reason,
        runKind: null,
        createdAtMs: now
      })

      const cas = this.jobRepository.compareAndSetJob({
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
        this.jobRepository.appendOutbox({
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
    this.jobRepository.transaction(() => {
      const failureId = this.idGenerator.generate()
      this.jobRepository.insertFailure({
        id: failureId,
        jobId: job.id,
        code: 'runtime.lost',
        recoverability: 'recoverable',
        reason,
        runKind: null,
        createdAtMs: now
      })

      const cas = this.jobRepository.compareAndSetJob({
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
        this.jobRepository.markRunState({
          runId: job.activeRunId,
          state: 'interrupted',
          stopReason: reason,
          updatedAtMs: now
        })
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
          changed: ['state', 'failure']
        },
        createdAtMs: now
      })
    })
  }
}
