/**
 * Planner → Command adapter.
 *
 * C6: Checkpoint and pause-ack paths call JobCommandService only.
 * There is no `updateJobRow` / legacy status write in this adapter.
 * Failure reporting stays on the executor/reconciler Command path
 * (`reportNoProgress` / crash recovery) — do not add legacy patches here.
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

export class PlannerAdapter {
  constructor(
    private readonly commandService: JobCommandService,
    private readonly idGenerator: IdGenerator,
    private readonly config: PlannerAdapterConfig
  ) {}

  async reportPlanCheckpoint(expectedRevision: number): Promise<void> {
    const envelope: WorkerCommandEnvelope<TaskCheckpointPayload> = {
      jobId: this.config.jobId,
      expectedRevision,
      runId: this.config.runId,
      fenceToken: this.config.fenceToken,
      executionGeneration: this.config.executionGeneration,
      payload: {
        attemptId: this.idGenerator.generate(),
        result: {
          status: 'completed',
          summary: 'Plan checkpoint',
          changedFiles: [],
          evidence: ['plan checkpoint recorded'],
          validation: { ran: false, outcome: 'not-applicable' },
          blockers: [],
          blockerKind: null
        }
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
