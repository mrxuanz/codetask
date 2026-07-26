import type Database from 'better-sqlite3'
import type { KernelTransaction, UnitOfWork } from '../../core/application/ports'
import { KernelSqliteDatabase } from './database'
import { SqliteAuthRepository } from './repositories/auth-repository'

function createTransaction(database: Database.Database): KernelTransaction {
  return { auth: new SqliteAuthRepository(database) }
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
