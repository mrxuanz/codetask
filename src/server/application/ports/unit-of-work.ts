import type { JobRepository } from './job-repository'
import type { RunRepository } from './run-repository'
import type { TaskRepository } from './task-repository'
import type { EvidenceRepository } from './evidence-repository'
import type { VerificationRepository } from './verification-repository'
import type { RuntimeInstanceRepository } from './runtime-instance-repository'
import type { ResourceSlotRepository } from './resource-slot-repository'
import type { OutboxRepository } from './outbox-repository'
import type { DedupRepository } from './dedup-repository'

export interface ControlPlaneTransaction {
  readonly jobs: JobRepository
  readonly runs: RunRepository
  readonly tasks: TaskRepository
  readonly evidence: EvidenceRepository
  readonly verifications: VerificationRepository
  readonly runtimes: RuntimeInstanceRepository
  readonly slots: ResourceSlotRepository
  readonly outbox: OutboxRepository
  readonly dedup: DedupRepository
}

export interface ControlPlaneUnitOfWork {
  /**
   * The callback must be synchronous; async work must run after commit.
   */
  transaction<T>(fn: (tx: ControlPlaneTransaction) => T): T
}
