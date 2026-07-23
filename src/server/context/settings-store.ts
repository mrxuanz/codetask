import Database from 'better-sqlite3'
import { dataPaths } from '../data-paths'
import type { AppDatabase } from '../db'

const NAMESPACE_TO_PROPERTY = {
  control_plane: 'controlPlane',
  prompts: 'prompts',
  retention: 'retention',
  user_mcp: 'userMcp',
  provider_runtime: 'providerRuntime',
  ui_server_preferences: 'uiServerPreferences'
} as const

type SettingsNamespace = keyof typeof NAMESPACE_TO_PROPERTY
type SettingsProperty = (typeof NAMESPACE_TO_PROPERTY)[SettingsNamespace]

const PROPERTY_TO_NAMESPACE = Object.fromEntries(
  Object.entries(NAMESPACE_TO_PROPERTY).map(([namespace, property]) => [property, namespace])
) as Record<SettingsProperty, SettingsNamespace>

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

  read(): Record<string, unknown> {
    const rows = this.sqlite
      .prepare(
        `SELECT namespace, value_json, schema_version, revision, updated_at
         FROM app_settings
         WHERE namespace IN (${Object.keys(NAMESPACE_TO_PROPERTY)
           .map(() => '?')
           .join(', ')})`
      )
      .all(...Object.keys(NAMESPACE_TO_PROPERTY)) as SettingsRow[]
    const result: Record<string, unknown> = {}
    for (const row of rows) {
      const property = NAMESPACE_TO_PROPERTY[row.namespace as SettingsNamespace]
      if (!property) continue
      result[property] = parseObjectJson(row.value_json, `settings namespace ${row.namespace}`)
    }
    return result
  }

  readNamespace(namespace: SettingsNamespace): {
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
    namespace: SettingsNamespace,
    value: Record<string, unknown>,
    options: { expectedRevision?: number; schemaVersion?: number } = {}
  ): number {
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

  write(value: Record<string, unknown>): void {
    const writeAll = this.sqlite.transaction(() => {
      for (const [property, namespace] of Object.entries(PROPERTY_TO_NAMESPACE)) {
        const next = value[property]
        if (next && typeof next === 'object' && !Array.isArray(next)) {
          this.writeNamespace(namespace, next as Record<string, unknown>)
        } else {
          this.sqlite.prepare(`DELETE FROM app_settings WHERE namespace = ?`).run(namespace)
        }
      }
    })
    writeAll()
  }

  patch(mutator: (file: Record<string, unknown>) => void): void {
    const patchAll = this.sqlite.transaction(() => {
      const file = this.read()
      const before = structuredClone(file)
      mutator(file)
      for (const [property, namespace] of Object.entries(PROPERTY_TO_NAMESPACE)) {
        const previous = before[property]
        const next = file[property]
        if (JSON.stringify(previous) === JSON.stringify(next)) continue
        if (next && typeof next === 'object' && !Array.isArray(next)) {
          this.writeNamespace(namespace, next as Record<string, unknown>)
        } else {
          this.sqlite.prepare(`DELETE FROM app_settings WHERE namespace = ?`).run(namespace)
        }
      }
    })
    patchAll()
  }
}
