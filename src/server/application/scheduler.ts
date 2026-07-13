import type { JobRepository } from './ports/job-repository'
import type { IdGenerator } from './ports/id-generator'
import type { Clock } from './ports/clock'
import type { SafeLogger } from './ports/safe-logger'

export interface SchedulerConfig {
  readonly pollIntervalMs: number
  readonly maxConcurrentJobs: number
}

export type RuntimeStarter = (jobId: string, runId: string, kind: 'planning' | 'execution') => void

export class Scheduler {
  private running = false
  private pollTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly config: SchedulerConfig,
    private readonly jobRepository: JobRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: SafeLogger,
    private readonly runtimeStarter: RuntimeStarter
  ) {}

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.logger.info('Scheduler started')
    this.pollTimer = setInterval(() => void this.tick(), this.config.pollIntervalMs)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.logger.info('Scheduler stopped')
  }

  private async tick(): Promise<void> {
    if (!this.running) return

    try {
      const eligibleJobs = this.jobRepository.getQueuedJobsForClaim(this.config.maxConcurrentJobs)

      for (const job of eligibleJobs) {
        this.claimJob(job)
      }
    } catch (error) {
      this.logger.error('Scheduler tick failed', { error: String(error) })
    }
  }

  private claimJob(job: { id: string; state: string; stateRevision: number; executionGeneration: number }): void {
    const now = this.clock.nowMs()
    const fenceToken = this.idGenerator.generate()
    const runId = this.idGenerator.generate()
    const pendingAttemptId = this.idGenerator.generate()
    const lifecycleOperationId = this.idGenerator.generate()
    const kind = job.state.startsWith('planning') ? ('planning' as const) : ('execution' as const)
    const targetState = job.state.startsWith('planning')
      ? ('planning_running' as const)
      : ('execution_running' as const)

    const claimed = this.jobRepository.transaction(() => {
      const cas = this.jobRepository.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: job.stateRevision,
        expectedState: job.state as Parameters<typeof this.jobRepository.compareAndSetJob>[0]['expectedState'],
        expectedActiveRunId: null,
        next: {
          state: targetState,
          controlIntent: 'none',
          resumeTarget: null,
          activeRunId: runId,
          lastFailureId: null,
          terminalAtMs: null
        }
      })

      if (!cas.ok) {
        return null
      }

      this.jobRepository.createRun({
        id: runId,
        jobId: job.id,
        kind,
        fenceToken,
        executionGeneration: job.executionGeneration,
        pendingAttemptId,
        lifecycleOperationId,
        startedAtMs: now
      })

      this.jobRepository.createSlot({
        id: this.idGenerator.generate(),
        jobId: job.id,
        runId,
        pool: 'default',
        createdAtMs: now
      })

      this.jobRepository.appendOutbox({
        topic: `job:${job.id}`,
        eventType: 'job.changed',
        entityId: job.id,
        aggregateRevision: cas.newRevision,
        createdAtMs: now,
        payload: {
          type: 'job.changed',
          entityId: job.id,
          revision: cas.newRevision,
          changed: ['state']
        }
      })

      return { runId, kind }
    })

    if (claimed) {
      this.logger.info('Job claimed', { jobId: job.id, runId: claimed.runId, kind: claimed.kind })
      this.runtimeStarter(job.id, claimed.runId, claimed.kind)
    }
  }

  isRunning(): boolean {
    return this.running
  }
}
