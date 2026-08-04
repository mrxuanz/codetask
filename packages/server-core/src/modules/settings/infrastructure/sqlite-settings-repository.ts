import type Database from 'better-sqlite3'
import { SETTING_NAMESPACES, type SettingNamespace } from '@codetask/contracts'
import { SettingsError } from '../domain/settings-errors.ts'
import type {
  SettingsRepository,
  StoredNamespace,
  WriteNamespaceResult
} from '../ports/settings-repository.ts'

const ALLOWED_NAMESPACES = new Set<string>(SETTING_NAMESPACES)

interface SettingsRow {
  namespace: string
  value_json: string
  revision: number
  updated_at: number
}

function parseObjectJson(raw: string, namespace: SettingNamespace): unknown {
  const value = JSON.parse(raw) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw SettingsError.badRequest(
      'settings.invalid_payload',
      `Namespace ${namespace} must contain a JSON object`
    )
  }
  return value
}

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly client: Database.Database) {}

  readNamespace<T = unknown>(namespace: SettingNamespace): StoredNamespace<T> {
    this.assertNamespace(namespace)
    const row = this.client
      .prepare(
        `SELECT namespace, value_json, revision, updated_at
           FROM app_settings
          WHERE namespace = ?`
      )
      .get(namespace) as SettingsRow | undefined

    if (!row) {
      return { value: null, revision: 0, updatedAt: 0 }
    }

    return {
      value: parseObjectJson(row.value_json, namespace) as T,
      revision: row.revision,
      updatedAt: row.updated_at
    }
  }

  writeNamespace(
    namespace: SettingNamespace,
    value: unknown,
    expectedRevision: number
  ): WriteNamespaceResult {
    this.assertNamespace(namespace)
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw SettingsError.badRequest(
        'settings.invalid_payload',
        'expectedRevision must be a non-negative integer'
      )
    }

    const write = this.client.transaction(() => {
      const current = this.readNamespace(namespace)
      if (current.revision !== expectedRevision) {
        throw SettingsError.conflict('settings.revision_conflict', 'Settings revision conflict', {
          namespace,
          expectedRevision,
          actualRevision: current.revision
        })
      }

      const revision = current.revision + 1
      const updatedAt = Math.floor(Date.now() / 1000)
      this.client
        .prepare(
          `INSERT INTO app_settings(namespace, value_json, schema_version, revision, updated_at)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(namespace) DO UPDATE SET
             value_json = excluded.value_json,
             schema_version = excluded.schema_version,
             revision = excluded.revision,
             updated_at = excluded.updated_at`
        )
        .run(namespace, JSON.stringify(value), revision, updatedAt)

      return { revision, updatedAt }
    })

    return write()
  }

  private assertNamespace(namespace: SettingNamespace): void {
    if (!ALLOWED_NAMESPACES.has(namespace)) {
      throw SettingsError.notFound(
        'settings.namespace_not_found',
        `Unknown namespace: ${namespace}`
      )
    }
  }
}
