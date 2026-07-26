import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { applyKernelMigrations } from './migrations'

export interface OpenKernelDatabaseOptions {
  readonly filename: string
  readonly busyTimeoutMs?: number
  readonly nowMs?: () => number
}

export class KernelSqliteDatabase {
  private closed = false

  constructor(readonly client: Database.Database) {}

  transaction<T>(work: () => T): T {
    if (this.closed) {
      throw new Error('kernel_database.closed')
    }
    return this.client.transaction(work)()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.client.close()
  }
}

export function openKernelDatabase(options: OpenKernelDatabaseOptions): KernelSqliteDatabase {
  if (options.filename !== ':memory:') {
    mkdirSync(dirname(options.filename), { recursive: true })
  }

  const client = new Database(options.filename)
  try {
    client.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`)
    client.pragma('foreign_keys = ON')
    client.pragma('auto_vacuum = INCREMENTAL')
    if (options.filename !== ':memory:') {
      client.pragma('journal_mode = WAL')
    }
    applyKernelMigrations(client, options.nowMs)
    return new KernelSqliteDatabase(client)
  } catch (error: unknown) {
    client.close()
    throw error
  }
}
