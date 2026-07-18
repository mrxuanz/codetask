import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import type Database from 'better-sqlite3'
import { createAppDatabaseForTests } from '../../../src/server/db'
import { bootstrapRuntime, ensureRuntimeReady, getAppContext, resetAppContextForTests } from '../../../src/server/bootstrap'
import { readSchemaGeneration, setCutoverMarkerForTests } from '../../../src/server/application/cutover-state'
import { StartupError } from '../../../src/server/application/startup-error'
import { createV3ApplicationRuntimeForTests } from '../../../src/server/application/application-runtime'
import { allMigrations } from '../../../src/server/db/migrations/index'
import { runMigrations } from '../../../src/server/db/migrations/runner'
import { dataPaths } from '../../../src/server/data-paths'
import DatabaseConstructor from 'better-sqlite3'

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
      assert.equal(readSchemaGeneration(createAppDatabaseForTests(sqlite)), 'legacy_v26')
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
      assert.throws(() => readSchemaGeneration(createAppDatabaseForTests(sqlite)), (error: unknown) => {
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
      assert.throws(() => readSchemaGeneration(createAppDatabaseForTests(sqlite)), (error: unknown) => {
        return error instanceof StartupError && error.code === 'schema.marker_invalid'
      })

      sqlite.prepare(`DELETE FROM control_schema_meta WHERE key = 'control_schema_generation'`).run()
      assert.throws(() => readSchemaGeneration(createAppDatabaseForTests(sqlite)), (error: unknown) => {
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

  it('blocks production bootstrap on v3_authoritative until cutover is release-ready', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cp-marker-v3-block-'))
    await resetAppContextForTests()
    setCutoverMarkerForTests('v3_authoritative')
    try {
      assert.throws(() => bootstrapRuntime({ dataDir }), (error: unknown) => {
        return error instanceof StartupError && error.code === 'control_plane.v3_not_release_ready'
      })
      assert.throws(() => getAppContext(), /Runtime not bootstrapped/)
      assert.throws(() => bootstrapRuntime({ dataDir }), (error: unknown) => {
        return error instanceof StartupError && error.code === 'control_plane.v3_not_release_ready'
      })
      assert.throws(() => getAppContext(), /Runtime not bootstrapped/)
    } finally {
      await resetAppContextForTests()
      setCutoverMarkerForTests(null)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('does not leave appContext after schema marker bootstrap failure', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cp-marker-boot-noctx-'))
    const sqlite = createDbAtMigrationVersion(28, dataDir)
    sqlite.exec('DROP TABLE control_schema_meta')
    sqlite.close()

    await resetAppContextForTests()
    setCutoverMarkerForTests(null)
    try {
      assert.throws(() => bootstrapRuntime({ dataDir }), (error: unknown) => {
        return error instanceof StartupError && error.code === 'schema.marker_table_missing'
      })
      assert.throws(() => getAppContext(), /Runtime not bootstrapped/)
      assert.throws(() => bootstrapRuntime({ dataDir }), (error: unknown) => {
        return error instanceof StartupError && error.code === 'schema.marker_table_missing'
      })
    } finally {
      await resetAppContextForTests()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('allows retry after legacy startup failure is cleared', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cp-marker-retry-'))
    await resetAppContextForTests()
    setCutoverMarkerForTests('copied')

    try {
      const ctx = bootstrapRuntime({ dataDir })
      await ensureRuntimeReady(ctx)
      const runtime = ctx.applicationRuntime
      assert.ok(runtime && runtime.kind === 'legacy')

      runtime.startPromise = null
      runtime.started = false
      const originalEnsureReady = runtime.startup.ensureReady.bind(runtime.startup)
      let failOnce = true
      runtime.startup.ensureReady = async () => {
        if (failOnce) {
          failOnce = false
          throw new Error('temp startup failure')
        }
        return originalEnsureReady()
      }

      await assert.rejects(() => ensureRuntimeReady(ctx), /temp startup failure/)
      await ensureRuntimeReady(ctx)
      assert.equal(runtime.startup.getPhase(), 'ready')
    } finally {
      await resetAppContextForTests()
      setCutoverMarkerForTests(null)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('test factory can start V3 outside production bootstrap', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cp-marker-v3-test-'))
    await resetAppContextForTests()
    setCutoverMarkerForTests('copied')
    try {
      const ctx = bootstrapRuntime({ dataDir })
      setCutoverMarkerForTests('v3_authoritative')
      ctx.applicationRuntime = createV3ApplicationRuntimeForTests(ctx)
      await ensureRuntimeReady(ctx)
      assert.equal(ctx.applicationRuntime.kind, 'v3')
      assert.equal(ctx.applicationRuntime.controlPlane.startup.getPhase(), 'ready')
    } finally {
      await resetAppContextForTests()
      setCutoverMarkerForTests(null)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
