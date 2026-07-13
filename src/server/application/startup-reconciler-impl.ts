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
    this.jobRepository.transaction(() => {
      const cas = this.jobRepository.compareAndSetJob({
        jobId: job.id,
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
          payload: { type: 'job.changed', entityId: job.id, revision: cas.newRevision, changed: ['state'] }
        })

        if (failureReason) {
          this.jobRepository.insertFailure({
            jobId: job.id,
            code: 'run.interrupted',
            recoverability: 'recoverable',
            reason: failureReason,
            runKind: null
          })
        }
      }
    })
  }

  private settleInterruptedFailure(job: JobAggregateView, reason: InterruptionReason): void {
    this.jobRepository.transaction(() => {
      const failureId = this.idGenerator.generate()
      const cas = this.jobRepository.compareAndSetJob({
        jobId: job.id,
        expectedRevision: job.stateRevision,
        expectedState: job.state,
        expectedActiveRunId: job.activeRunId,
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
        this.jobRepository.insertFailure({
          jobId: job.id,
          code: 'run.interrupted',
          recoverability: 'recoverable',
          reason,
          runKind: null
        })

        this.jobRepository.appendOutbox({
          topic: `job:${job.id}`,
          eventType: 'job.changed',
          entityId: job.id,
          aggregateRevision: cas.newRevision,
          payload: { type: 'job.changed', entityId: job.id, revision: cas.newRevision, changed: ['state', 'failure'] }
        })
      }
    })
  }

  private settleRuntimeLost(job: JobAggregateView, reason: 'child_closed' | 'owner_missing'): void {
    this.logger.info('Settling runtime lost', { jobId: job.id, reason })
    // Runtime lost is handled by RuntimeExited command in PR3
    // For now, just log - the actual convergence happens via RuntimeExited
  }
}
