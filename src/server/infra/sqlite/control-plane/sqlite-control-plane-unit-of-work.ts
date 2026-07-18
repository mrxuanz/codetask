import type { ControlPlaneTransaction, ControlPlaneUnitOfWork } from '../../../application/ports/unit-of-work'
import type { ControlPlaneDatabase } from './db-executor'
import { SqliteJobRepository } from './job-repository'
import { SqliteRunRepository } from './sqlite-run-repository'
import { SqliteTaskRepository } from './task-repository'
import { SqliteEvidenceRepository } from './evidence-repository'
import { SqliteVerificationRepository } from './verification-repository'
import { SqliteRuntimeInstanceRepository } from './sqlite-runtime-repository'
import { SqliteResourceSlotRepository } from './sqlite-slot-repository'
import { SqliteOutboxRepository } from './sqlite-outbox-repository'
import { SqliteDedupRepository } from './sqlite-dedup-repository'

function createTransaction(tx: Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]): ControlPlaneTransaction {
  return {
    jobs: new SqliteJobRepository(tx),
    runs: new SqliteRunRepository(tx),
    tasks: new SqliteTaskRepository(tx),
    evidence: new SqliteEvidenceRepository(tx),
    verifications: new SqliteVerificationRepository(tx),
    runtimes: new SqliteRuntimeInstanceRepository(tx),
    slots: new SqliteResourceSlotRepository(tx),
    outbox: new SqliteOutboxRepository(tx),
    dedup: new SqliteDedupRepository(tx)
  }
}

export class SqliteControlPlaneUnitOfWork implements ControlPlaneUnitOfWork {
  constructor(private readonly db: ControlPlaneDatabase) {}

  transaction<T>(fn: (tx: ControlPlaneTransaction) => T): T {
    return this.db.transaction((tx) => fn(createTransaction(tx)))
  }
}

export function createControlPlaneTransaction(
  db: ControlPlaneDatabase
): ControlPlaneUnitOfWork & {
  readonly jobs: SqliteJobRepository
  readonly runs: SqliteRunRepository
  readonly tasks: SqliteTaskRepository
  readonly evidence: SqliteEvidenceRepository
  readonly verifications: SqliteVerificationRepository
  readonly runtimes: SqliteRuntimeInstanceRepository
  readonly slots: SqliteResourceSlotRepository
  readonly outbox: SqliteOutboxRepository
  readonly dedup: SqliteDedupRepository
} {
  const jobs = new SqliteJobRepository(db)
  const runs = new SqliteRunRepository(db)
  const tasks = new SqliteTaskRepository(db)
  const evidence = new SqliteEvidenceRepository(db)
  const verifications = new SqliteVerificationRepository(db)
  const runtimes = new SqliteRuntimeInstanceRepository(db)
  const slots = new SqliteResourceSlotRepository(db)
  const outbox = new SqliteOutboxRepository(db)
  const dedup = new SqliteDedupRepository(db)
  const uow = new SqliteControlPlaneUnitOfWork(db)

  return Object.assign(uow, { jobs, runs, tasks, evidence, verifications, runtimes, slots, outbox, dedup })
}
