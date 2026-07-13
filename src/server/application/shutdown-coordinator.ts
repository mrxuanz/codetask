import type { SafeLogger } from './ports/safe-logger'

export type ShutdownReason = 'app_shutdown' | 'user_quit' | 'signal'

export interface ShutdownDependencies {
  readonly scheduler: { stop(): Promise<void> }
  readonly outboxDispatcher: { flushWithin(ms: number): Promise<void> }
  readonly runtimeSupervisor: { closeAll(): Promise<void> }
  readonly logger: SafeLogger
}

export interface ShutdownConfig {
  readonly outboxFlushDeadlineMs: number
}

export class ShutdownCoordinator {
  private shutdownPromise: Promise<void> | null = null
  private draining = false

  constructor(
    private readonly deps: ShutdownDependencies,
    private readonly config: ShutdownConfig = { outboxFlushDeadlineMs: 5000 }
  ) {}

  isDraining(): boolean {
    return this.draining
  }

  async shutdown(reason: ShutdownReason): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise
    this.shutdownPromise = this.run(reason)
    return this.shutdownPromise
  }

  private async run(reason: ShutdownReason): Promise<void> {
    this.draining = true
    this.deps.logger.info('Shutdown started', { reason })

    try {
      // 1. Stop scheduler (no new claims)
      await this.deps.scheduler.stop()

      // 2. Flush outbox within deadline
      await this.deps.outboxDispatcher.flushWithin(this.config.outboxFlushDeadlineMs)

      // 3. Close all runtimes (waits for closed or kills on timeout)
      await this.deps.runtimeSupervisor.closeAll()

      this.deps.logger.info('Shutdown completed')
    } catch (error) {
      this.deps.logger.error('Shutdown failed', { error: String(error) })
    }
  }
}
