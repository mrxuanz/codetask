import type { SafeLogger } from './ports/safe-logger'

export type StartupPhase =
  | 'idle'
  | 'reconciling'
  | 'waiting_runtime_supervisor'
  | 'ready'
  | 'degraded'

export interface StartupStage {
  readonly name: string
  execute(): Promise<void>
}

export interface StartupCoordinatorConfig {
  readonly logger: SafeLogger
  readonly stages: readonly StartupStage[]
}

export class StartupCoordinator {
  private inflight: Promise<void> | null = null
  private phase: StartupPhase = 'idle'
  private lastError: string | null = null

  constructor(private readonly config: StartupCoordinatorConfig) {}

  async ensureReady(): Promise<void> {
    if (this.phase === 'ready') return Promise.resolve()
    if (this.inflight !== null) return this.inflight

    this.phase = 'reconciling'
    this.lastError = null

    this.inflight = this.runAllStages()
      .then(() => {
        this.phase = 'ready'
        this.config.logger.info('Startup completed successfully')
      })
      .catch((error: unknown) => {
        this.phase = 'degraded'
        this.lastError = error instanceof Error ? error.message : String(error)
        this.config.logger.error('Startup failed', { error: this.lastError })
        throw error
      })
      .finally(() => {
        this.inflight = null
      })

    return this.inflight
  }

  getPhase(): StartupPhase {
    return this.phase
  }

  getLastError(): string | null {
    return this.lastError
  }

  private async runAllStages(): Promise<void> {
    for (const stage of this.config.stages) {
      this.config.logger.info(`Startup stage: ${stage.name}`)
      try {
        await stage.execute()
      } catch (error: unknown) {
        this.config.logger.error(`Startup stage failed: ${stage.name}`, {
          error: error instanceof Error ? error.message : String(error)
        })
        throw error
      }
    }
  }
}
