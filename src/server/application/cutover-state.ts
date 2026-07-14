/**
 * Cutover marker helpers for production gating (C16 uses isV3Authoritative for 410).
 *
 * Reads `control_schema_meta.key = 'control_schema_generation'` when present.
 * Tests may override via setCutoverMarkerForTests (also used by cutover-schema-generation).
 */
import type Database from 'better-sqlite3'
import type { AppDatabase } from '../db'
import { getDb } from '../db'
import { StartupError } from './startup-error'

export type SchemaGeneration = 'preparing' | 'copied' | 'v3_authoritative'

export type SchemaGenerationRead = SchemaGeneration | 'legacy_v26'

export const CUTOVER_MARKER_KEY = 'control_schema_generation' as const

let inMemoryOverride: SchemaGeneration | null = null

function getSqliteClient(db: AppDatabase): Database.Database | null {
  return (db as AppDatabase & { $client?: Database.Database }).$client ?? null
}

function tableExists(client: Database.Database, table: string): boolean {
  const row = client
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { ok: number } | undefined
  return Boolean(row)
}

function readMigrationVersion(client: Database.Database): number {
  if (!tableExists(client, 'schema_migrations')) {
    return 0
  }
  const row = client.prepare(`SELECT MAX(version) AS version FROM schema_migrations`).get() as
    | { version: number | null }
    | undefined
  return row?.version ?? 0
}

function parseSchemaGeneration(value: string): SchemaGeneration {
  if (value === 'preparing' || value === 'copied' || value === 'v3_authoritative') {
    return value
  }
  throw new StartupError('schema.marker_invalid')
}

/** Test-only override. Pass null to clear (falls back to strict DB read). */
export function setCutoverMarkerForTests(value: SchemaGeneration | null): void {
  inMemoryOverride = value
}

/**
 * Strict marker read — fail closed. Never returns `preparing` as a soft default.
 * `legacy_v26` only when control schema meta is absent and migration version <= 26.
 */
export function readSchemaGeneration(db: AppDatabase): SchemaGenerationRead {
  if (inMemoryOverride !== null) {
    return inMemoryOverride
  }

  const client = getSqliteClient(db)
  if (!client) {
    throw new StartupError('schema.db_unavailable')
  }

  const hasMeta = tableExists(client, 'control_schema_meta')
  if (!hasMeta) {
    const migrationVersion = readMigrationVersion(client)
    if (migrationVersion <= 26) {
      return 'legacy_v26'
    }
    throw new StartupError('schema.marker_table_missing')
  }

  const rows = client
    .prepare(`SELECT value FROM control_schema_meta WHERE key = ?`)
    .all(CUTOVER_MARKER_KEY) as Array<{ value: string }>

  if (rows.length !== 1) {
    throw new StartupError('schema.marker_invalid')
  }

  return parseSchemaGeneration(rows[0].value)
}

/**
 * Resolve cutover generation for runtime gating. Maps `legacy_v26` → `preparing`.
 * Prefer `readSchemaGeneration` at bootstrap for fail-closed routing.
 */
export function getCutoverMarker(db?: AppDatabase | null): SchemaGeneration {
  if (inMemoryOverride !== null) {
    return inMemoryOverride
  }

  const database = db ?? getDb()
  const generation = readSchemaGeneration(database)
  if (generation === 'legacy_v26') {
    return 'preparing'
  }
  return generation
}

export function isV3Authoritative(db?: AppDatabase | null): boolean {
  if (inMemoryOverride !== null) {
    return inMemoryOverride === 'v3_authoritative'
  }
  const database = db ?? getDb()
  return readSchemaGeneration(database) === 'v3_authoritative'
}
