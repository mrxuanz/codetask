/**
 * Planner → Command adapter.
 *
 * C6: Checkpoint and pause-ack paths call JobCommandService only.
 * Plan checkpoint payloads must come from an injected provider — never synthesized here.
 */
import type {
  JobCommandService,
  WorkerCommandEnvelope,
  TaskCheckpointPayload,
  PauseAcknowledgedPayload
} from '@shared/contracts/control-plane'
import type { IdGenerator } from './ports/id-generator'

export interface PlannerAdapterConfig {
  readonly jobId: string
  readonly runId: string
  readonly fenceToken: string
  readonly executionGeneration: number
}

export interface PlanningCheckpointProvider {
  readonly attemptId: string
  produceCheckpointResult(): Promise<unknown>
}

export class PlannerAdapter {
  constructor(
    private readonly commandService: JobCommandService,
    private readonly idGenerator: IdGenerator,
    private readonly config: PlannerAdapterConfig
  ) {}

  async reportPlanCheckpoint(
    expectedRevision: number,
    provider: PlanningCheckpointProvider
  ): Promise<void> {
    const envelope: WorkerCommandEnvelope<TaskCheckpointPayload> = {
      jobId: this.config.jobId,
      expectedRevision,
      runId: this.config.runId,
      fenceToken: this.config.fenceToken,
      executionGeneration: this.config.executionGeneration,
      payload: {
        attemptId: provider.attemptId,
        result: await provider.produceCheckpointResult()
      }
    }

    await this.commandService.checkpointTask(envelope)
  }

  async acknowledgePause(expectedRevision: number): Promise<void> {
    const envelope: WorkerCommandEnvelope<PauseAcknowledgedPayload> = {
      jobId: this.config.jobId,
      expectedRevision,
      runId: this.config.runId,
      fenceToken: this.config.fenceToken,
      executionGeneration: this.config.executionGeneration,
      payload: {}
    }

    await this.commandService.acknowledgePause(envelope)
  }

  async reportFailure(expectedRevision: number, reason: string): Promise<void> {
    void reason
    void expectedRevision
    // Failure reporting is handled by the executor loop via reportNoProgress
    // or by the reconciler on crash recovery
  }
}
