import type Database from 'better-sqlite3'

const COUNTED_TABLES = [
  'auth_users',
  'auth_sessions',
  'auth_throttles',
  'auth_challenges',
  'auth_audit'
] as const

export interface ForeignKeyViolation {
  readonly table: string
  readonly rowId: number | null
  readonly parent: string
  readonly foreignKeyIndex: number
}

export interface KernelDatabaseValidation {
  readonly ok: boolean
  readonly integrity: string
  readonly foreignKeyViolations: readonly ForeignKeyViolation[]
  readonly rowCounts: Readonly<Record<(typeof COUNTED_TABLES)[number], number>>
}

export function validateKernelDatabase(database: Database.Database): KernelDatabaseValidation {
  const integrityRow = database.prepare(`PRAGMA integrity_check`).get() as
    | { integrity_check: string }
    | undefined
  const integrity = integrityRow?.integrity_check ?? 'missing'
  const violations = database.prepare(`PRAGMA foreign_key_check`).all() as Array<{
    table: string
    rowid: number | null
    parent: string
    fkid: number
  }>
  const rowCounts = Object.fromEntries(
    COUNTED_TABLES.map((table) => {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
        count: number
      }
      return [table, row.count]
    })
  ) as Record<(typeof COUNTED_TABLES)[number], number>

  return {
    ok: integrity === 'ok' && violations.length === 0,
    integrity,
    foreignKeyViolations: violations.map((row) => ({
      table: row.table,
      rowId: row.rowid,
      parent: row.parent,
      foreignKeyIndex: row.fkid
    })),
    rowCounts: Object.freeze(rowCounts)
  }
}
