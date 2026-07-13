import type { JobRepository } from './job-repository'

/**
 * Transaction boundary for control-plane commands. Additional repositories can
 * be added here when they need to be transaction-scoped by a future adapter.
 */
export interface ControlPlaneTransaction {
  readonly jobs: JobRepository
}

export interface ControlPlaneUnitOfWork {
  /**
   * The callback must be synchronous; async work must run after commit.
   */
  transaction<T>(fn: (tx: ControlPlaneTransaction) => T): T
}
