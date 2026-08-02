import Database from 'better-sqlite3'
import { dataPaths } from '../data-paths'
import type { AppDatabase } from '../db'
import { SETTING_NAMESPACES, type SettingNamespace } from '@codetask/contracts'

interface SettingsRow {
  namespace: string
  value_json: string
  schema_version: number
  revision: number
  updated_at: number
}

function sqliteClient(database: AppDatabase): Database.Database {
  const client = (database as AppDatabase & { $client?: Database.Database }).$client
  if (!client) throw new Error('Settings repository requires a SQLite client')
  return client
}

function parseObjectJson(raw: string, label: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

export class SettingsRevisionConflictError extends Error {
  constructor(
    readonly namespace: string,
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `Settings revision conflict for ${namespace}: expected ${expectedRevision}, got ${actualRevision}`
    )
  }
}

/**
 * Host-side namespace reader used at bootstrap for provider_runtime.
 * Business Settings CRUD goes through packages/server-core Settings module.
 * Also supports host-only `runtime_maintenance` for sqlite maintenance cursor.
 */
export class SettingsStore {
  private readonly sqlite: Database.Database
  private readonly ownsConnection: boolean

  constructor(dataDir: string, database?: AppDatabase) {
    if (database) {
      this.sqlite = sqliteClient(database)
      this.ownsConnection = false
    } else {
      this.sqlite = new Database(dataPaths(dataDir).dbFile)
      this.ownsConnection = true
    }
  }

  close(): void {
    if (this.ownsConnection && this.sqlite.open) this.sqlite.close()
  }

  readNamespace(namespace: SettingNamespace | 'runtime_maintenance'): {
    value: Record<string, unknown> | null
    revision: number
    schemaVersion: number
  } {
    const row = this.sqlite
      .prepare(
        `SELECT namespace, value_json, schema_version, revision, updated_at
         FROM app_settings WHERE namespace = ?`
      )
      .get(namespace) as SettingsRow | undefined
    return row
      ? {
          value: parseObjectJson(row.value_json, `settings namespace ${namespace}`),
          revision: row.revision,
          schemaVersion: row.schema_version
        }
      : { value: null, revision: 0, schemaVersion: 1 }
  }

  writeNamespace(
    namespace: SettingNamespace | 'runtime_maintenance',
    value: Record<string, unknown>,
    options: { expectedRevision?: number; schemaVersion?: number } = {}
  ): number {
    if (
      namespace !== 'runtime_maintenance' &&
      !(SETTING_NAMESPACES as readonly string[]).includes(namespace)
    ) {
      throw new Error(`Unsupported settings namespace: ${namespace}`)
    }
    const write = this.sqlite.transaction(() => {
      const current = this.readNamespace(namespace)
      if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
        throw new SettingsRevisionConflictError(
          namespace,
          options.expectedRevision,
          current.revision
        )
      }
      const revision = current.revision + 1
      this.sqlite
        .prepare(
          `INSERT INTO app_settings(namespace, value_json, schema_version, revision, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(namespace) DO UPDATE SET
             value_json = excluded.value_json,
             schema_version = excluded.schema_version,
             revision = excluded.revision,
             updated_at = excluded.updated_at`
        )
        .run(
          namespace,
          JSON.stringify(value),
          options.schemaVersion ?? current.schemaVersion ?? 1,
          revision,
          Math.floor(Date.now() / 1000)
        )
      return revision
    })
    return write()
  }
}
