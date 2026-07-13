/**
 * Cutover marker helpers for production gating (C16 uses isV3Authoritative for 410).
 *
 * Reads `control_schema_meta.key = 'control_schema_generation'` when present.
 * Tests may override via setCutoverMarkerForTests (also used by cutover-schema-generation).
 */
import type Database from 'better-sqlite3'
import type { AppDatabase } from '../db'
import { getDb } from '../db'

export type SchemaGeneration = 'preparing' | 'copied' | 'v3_authoritative'

export const CUTOVER_MARKER_KEY = 'control_schema_generation' as const

let inMemoryOverride: SchemaGeneration | null = null

function getSqliteClient(db: AppDatabase): Database.Database | null {
  return (db as AppDatabase & { $client?: Database.Database }).$client ?? null
}

function controlSchemaMetaExists(client: Database.Database): boolean {
  try {
    const row = client
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'control_schema_meta'`
      )
      .get() as { ok: number } | undefined
    return Boolean(row)
  } catch {
    return false
  }
}

function parseGeneration(value: string | null | undefined): SchemaGeneration {
  if (value === 'copied' || value === 'v3_authoritative' || value === 'preparing') {
    return value
  }
  return 'preparing'
}

/** Test-only override. Pass null to clear (falls back to DB / preparing). */
export function setCutoverMarkerForTests(value: SchemaGeneration | null): void {
  inMemoryOverride = value
}

/**
 * Resolve cutover generation: in-memory override → DB meta → preparing.
 * Safe on legacy-only DBs (missing table → preparing).
 * When `db` is omitted, tries getDb() if initialized.
 */
export function getCutoverMarker(db?: AppDatabase | null): SchemaGeneration {
  if (inMemoryOverride !== null) {
    return inMemoryOverride
  }

  let database = db ?? null
  if (!database) {
    try {
      database = getDb()
    } catch {
      return 'preparing'
    }
  }

  const client = getSqliteClient(database)
  if (!client || !controlSchemaMetaExists(client)) {
    return 'preparing'
  }
  try {
    const row = client
      .prepare(`SELECT value FROM control_schema_meta WHERE key = ?`)
      .get(CUTOVER_MARKER_KEY) as { value: string } | undefined
    return parseGeneration(row?.value)
  } catch {
    return 'preparing'
  }
}

export function isV3Authoritative(db?: AppDatabase | null): boolean {
  return getCutoverMarker(db) === 'v3_authoritative'
}
