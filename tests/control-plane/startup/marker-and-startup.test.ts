import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import type Database from 'better-sqlite3'
import type { AppDatabase } from '../../../src/server/db'
import { bootstrapRuntime, ensureRuntimeReady, resetAppContextForTests } from '../../../src/server/bootstrap'
import { readSchemaGeneration, setCutoverMarkerForTests } from '../../../src/server/application/cutover-state'
import { StartupError } from '../../../src/server/application/startup-error'
import { allMigrations } from '../../../src/server/db/migrations/index'
import { runMigrations } from '../../../src/server/db/migrations/runner'
import { dataPaths } from '../../../src/server/data-paths'
import DatabaseConstructor from 'better-sqlite3'

function asAppDatabase(client: Database.Database): AppDatabase {
  return { $client: client } as AppDatabase
}

function createDbAtMigrationVersion(version: number, dataDir: string): Database.Database {
  const dbPath = dataPaths(dataDir).dbFile
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('foreign_keys = ON')
  const migrations = allMigrations.filter((migration) => migration.version <= version)
  runMigrations(db, migrations)
  return db
}

describe('startup: strict marker parsing', () => {
  it('returns legacy_v26 when control meta is absent and migration version <= 26', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cp-marker-legacy-'))
    const sqlite = createDbAtMigrationVersion(26, dataDir)
    try {
      assert.equal(readSchemaGeneration(asAppDatabase(sqlite)), 'legacy_v26')
    } finally {
      sqlite.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('throws marker_table_missing when control schema exists without meta at migration > 26', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cp-marker-missing-'))
    const sqlite = createDbAtMigrationVersion(28, dataDir)
    sqlite.exec('DROP TABLE control_schema_meta')
    try {
      assert.throws(() => readSchemaGeneration(asAppDatabase(sqlite)), (error: unknown) => {
        return error instanceof StartupError && error.code === 'schema.marker_table_missing'
      })
    } finally {
      sqlite.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('throws marker_invalid when generation key has invalid value', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cp-marker-invalid-'))
    const sqlite = createDbAtMigrationVersion(28, dataDir)
    try {
      sqlite
        .prepare(
          `UPDATE control_schema_meta SET value = 'bogus' WHERE key = 'control_schema_generation'`
        )
        .run()
      assert.throws(() => readSchemaGeneration(asAppDatabase(sqlite)), (error: unknown) => {
        return error instanceof StartupError && error.code === 'schema.marker_invalid'
      })

      sqlite.prepare(`DELETE FROM control_schema_meta WHERE key = 'control_schema_generation'`).run()
      assert.throws(() => readSchemaGeneration(asAppDatabase(sqlite)), (error: unknown) => {
        return error instanceof StartupError && error.code === 'schema.marker_invalid'
      })
    } finally {
      sqlite.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('blocks bootstrap when marker table is missing after control schema migration', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cp-marker-boot-'))
    const sqlite = createDbAtMigrationVersion(28, dataDir)
    sqlite.exec('DROP TABLE control_schema_meta')
    sqlite.close()

    await resetAppContextForTests()
    setCutoverMarkerForTests(null)
    try {
      assert.throws(() => bootstrapRuntime({ dataDir }), (error: unknown) => {
        return error instanceof StartupError && error.code === 'schema.marker_table_missing'
      })
    } finally {
      await resetAppContextForTests()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('allows retry after startup failure is cleared', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cp-marker-retry-'))
    await resetAppContextForTests()
    setCutoverMarkerForTests('v3_authoritative')

    try {
      const ctx = bootstrapRuntime({ dataDir })
      const runtime = ctx.applicationRuntime
      assert.ok(runtime && runtime.kind === 'v3')

      const originalEnsureReady = runtime.controlPlane.startup.ensureReady.bind(runtime.controlPlane.startup)
      let failOnce = true
      runtime.controlPlane.startup.ensureReady = async () => {
        if (failOnce) {
          failOnce = false
          throw new Error('temp startup failure')
        }
        return originalEnsureReady()
      }

      await assert.rejects(() => ensureRuntimeReady(ctx), /temp startup failure/)
      await ensureRuntimeReady(ctx)
      assert.equal(runtime.controlPlane.startup.getPhase(), 'ready')
    } finally {
      await resetAppContextForTests()
      setCutoverMarkerForTests(null)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
