import { DatabaseSync, type StatementSync } from 'node:sqlite'

/**
 * Minimal better-sqlite3-shaped adapter for Node-core tests.
 *
 * Production still uses the existing better-sqlite3 driver. This adapter keeps Hono/auth/migration
 * tests on Node's built-in SQLite and never depends on Electron's native-module ABI.
 */
export class NodeSqliteAdapter {
  private readonly database = new DatabaseSync(':memory:')
  private transactionDepth = 0

  exec(sql: string): void {
    this.database.exec(sql)
  }

  prepare(sql: string): StatementSync {
    return this.database.prepare(sql)
  }

  pragma(statement: string): void {
    this.database.exec(`PRAGMA ${statement}`)
  }

  transaction<T>(action: () => T): () => T {
    return () => {
      const depth = this.transactionDepth
      const savepoint = `node_test_transaction_${depth}`
      this.transactionDepth += 1
      this.database.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
      try {
        const result = action()
        this.database.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`)
        return result
      } catch (error) {
        if (depth === 0) {
          this.database.exec('ROLLBACK')
        } else {
          this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          this.database.exec(`RELEASE SAVEPOINT ${savepoint}`)
        }
        throw error
      } finally {
        this.transactionDepth -= 1
      }
    }
  }

  close(): void {
    this.database.close()
  }
}
