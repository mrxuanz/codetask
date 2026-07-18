import type { JobRepository } from './ports/job-repository'
import type { ControlPlaneUnitOfWork } from './ports/unit-of-work'
import type { IdGenerator } from './ports/id-generator'
import type { Clock } from './ports/clock'
import type { SafeLogger } from './ports/safe-logger'

export interface SchedulerConfig {
  readonly pollIntervalMs: number
  readonly maxConcurrentJobs: number
}

export interface SchedulerCapabilities {
  readonly planning: boolean
  readonly execution: boolean
}

export type RuntimeStarter = (jobId: string, runId: string, kind: 'planning' | 'execution') => void

const DEFAULT_POOL = 'default'

export class Scheduler {
  private running = false
  private pollTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly config: SchedulerConfig,
    private readonly capabilities: SchedulerCapabilities,
    private readonly jobRepository: JobRepository,
    private readonly unitOfWork: ControlPlaneUnitOfWork,
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
      const activeSlots = this.unitOfWork.transaction((tx) =>
        tx.slots.countActiveSlots(DEFAULT_POOL)
      )
      const remainingCapacity = Math.max(0, this.config.maxConcurrentJobs - activeSlots)
      if (remainingCapacity === 0) return

      const eligibleJobs = this.jobRepository
        .getQueuedJobsForClaim(remainingCapacity)
        .filter((job) => this.canClaimState(job.state))

      for (const job of eligibleJobs) {
        this.claimJob(job)
      }
    } catch (error) {
      this.logger.error('Scheduler tick failed', { error: String(error) })
    }
  }

  private canClaimState(state: string): boolean {
    if (state === 'planning_queued') return this.capabilities.planning
    if (state === 'execution_queued') return this.capabilities.execution
    return false
  }

  private claimJob(job: {
    id: string
    state: string
    stateRevision: number
    executionGeneration: number
  }): void {
    const now = this.clock.nowMs()
    const fenceToken = this.idGenerator.generate()
    const runId = this.idGenerator.generate()
    const kind = job.state.startsWith('planning') ? ('planning' as const) : ('execution' as const)
    const targetState = job.state.startsWith('planning')
      ? ('planning_running' as const)
      : ('execution_running' as const)

    const claimed = this.unitOfWork.transaction((tx) => {
      tx.slots.assertCapacityAvailable(DEFAULT_POOL, this.config.maxConcurrentJobs)

      const cas = tx.jobs.compareAndSetJob({
        jobId: job.id,
        updatedAtMs: now,
        expectedRevision: job.stateRevision,
        expectedState: job.state as Parameters<typeof tx.jobs.compareAndSetJob>[0]['expectedState'],
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

      tx.runs.createRun({
        id: runId,
        jobId: job.id,
        kind,
        fenceToken,
        executionGeneration: job.executionGeneration,
        startedAtMs: now
      })

      tx.slots.createSlot({
        id: this.idGenerator.generate(),
        jobId: job.id,
        runId,
        pool: DEFAULT_POOL,
        createdAtMs: now
      })

      tx.outbox.appendOutbox({
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
