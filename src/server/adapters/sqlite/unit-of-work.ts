import type { ApplicationEvent, EventPublisher } from '../../core/application/ports/event-publisher'
import type { UnitOfWork } from '../../core/application/ports/unit-of-work'
import type { SqliteDatabase } from './migrate-core'
import type { CoreRepositories } from './ports'
import { SqliteArtifactRepository } from './repositories/artifact-repository'
import { SqliteDraftRepository } from './repositories/draft-repository'
import { SqliteJobRepository } from './repositories/job-repository'
import { SqliteOutboxRepository } from './repositories/outbox-repository'
import { SqlitePlanRepository } from './repositories/plan-repository'
import { SqliteTaskRepository } from './repositories/task-repository'
import { SqliteThreadRepository } from './repositories/thread-repository'

export type SqliteUnitOfWorkHandle = UnitOfWork & CoreRepositories

const noopPublisher: EventPublisher = {
  async publish(): Promise<void> {
    // default: discard (tests / adapters that only need DB transaction)
  }
}

/**
 * SQLite-backed unit of work for the new core.
 * Uses BEGIN IMMEDIATE / COMMIT / ROLLBACK so async command handlers can await
 * while still keeping repository writes in one transaction.
 * Collects ApplicationEvents and publishes them after successful commit.
 */
export class SqliteUnitOfWork implements SqliteUnitOfWorkHandle {
  readonly threads: SqliteThreadRepository
  readonly drafts: SqliteDraftRepository
  readonly plans: SqlitePlanRepository
  readonly jobs: SqliteJobRepository
  readonly tasks: SqliteTaskRepository
  readonly outbox: SqliteOutboxRepository
  readonly artifacts: SqliteArtifactRepository

  private depth = 0
  private pending: ApplicationEvent[] = []

  constructor(
    private readonly db: SqliteDatabase,
    private readonly publisher: EventPublisher = noopPublisher
  ) {
    this.threads = new SqliteThreadRepository(db)
    this.drafts = new SqliteDraftRepository(db)
    this.plans = new SqlitePlanRepository(db)
    this.jobs = new SqliteJobRepository(db)
    this.tasks = new SqliteTaskRepository(db)
    this.outbox = new SqliteOutboxRepository(db)
    this.artifacts = new SqliteArtifactRepository(db)
  }

  enqueueEvent(event: ApplicationEvent): void {
    this.pending.push(event)
  }

  /** Events collected in the current (outer) transaction — for tests. */
  get pendingEvents(): readonly ApplicationEvent[] {
    return this.pending
  }

  async run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const isOuter = this.depth === 0
    if (isOuter) {
      this.pending = []
      this.db.exec('BEGIN IMMEDIATE')
    }
    this.depth += 1
    try {
      const result = await fn(this)
      if (isOuter) {
        this.db.exec('COMMIT')
        const toPublish = [...this.pending]
        this.pending = []
        for (const event of toPublish) {
          await this.publisher.publish(event)
        }
      }
      return result
    } catch (error) {
      if (isOuter) {
        this.pending = []
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // ignore rollback errors after failed begin/commit
        }
      }
      throw error
    } finally {
      this.depth -= 1
    }
  }
}

export function createSqliteUnitOfWork(
  db: SqliteDatabase,
  publisher?: EventPublisher
): SqliteUnitOfWork {
  return new SqliteUnitOfWork(db, publisher)
}
