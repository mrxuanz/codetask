import type Database from 'better-sqlite3'
import type { KernelTransaction, UnitOfWork } from '../../core/application/ports'
import { KernelSqliteDatabase } from './database'
import { SqliteAuthRepository } from './repositories/auth-repository'
import { SqliteConversationRepository } from './repositories/conversation-repository'
import { SqliteDraftRepository } from './repositories/draft-repository'
import { SqliteJobIntakeRepository } from './repositories/job-intake-repository'
import { SqliteJobRepository } from './repositories/job-repository'

function createTransaction(database: Database.Database): KernelTransaction {
  return {
    auth: new SqliteAuthRepository(database),
    conversation: new SqliteConversationRepository(database),
    draft: new SqliteDraftRepository(database),
    jobIntake: new SqliteJobIntakeRepository(database),
    job: new SqliteJobRepository(database)
  }
}

export class SqliteUnitOfWork implements UnitOfWork {
  constructor(private readonly database: KernelSqliteDatabase) {}

  transaction<T>(work: (transaction: KernelTransaction) => T): T {
    return this.database.transaction(() => work(createTransaction(this.database.client)))
  }
}

export function createSqliteRepositories(database: KernelSqliteDatabase): KernelTransaction {
  return createTransaction(database.client)
}
