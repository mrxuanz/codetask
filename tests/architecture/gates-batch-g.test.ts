/**
 * Batch G architecture gates — migration ledger, assets, dead table removal.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  MIGRATION_MANIFEST,
  SCHEMA_REGISTRY,
  assertManifestContiguous,
  listManifestMigrations
} from '@codetask/database'
import { allMigrations } from '../../src/server/db/migrations'
import { assertMigrationsAlignWithManifest, runMigrations } from '@codetask/database'

const root = join(import.meta.dirname, '../..')

describe('architecture gates — Batch G', () => {
  it('migration manifest is contiguous and includes tombstones 22/37/38', () => {
    assertManifestContiguous()
    const tombstones = MIGRATION_MANIFEST.filter((entry) => entry.kind === 'tombstone').map(
      (entry) => entry.version
    )
    assert.deepEqual(tombstones, [22, 37, 38])
    assertMigrationsAlignWithManifest(allMigrations)
  })

  it('runner list matches manifest migration identities', () => {
    const manifest = listManifestMigrations()
    assert.equal(allMigrations.length, manifest.length)
    for (const entry of manifest) {
      const migration = allMigrations.find((item) => item.version === entry.version)
      assert.ok(migration, `missing v${entry.version}`)
      assert.equal(migration!.name, entry.name)
    }
  })

  it('fresh migrate creates assets tables and drops dead runtime tables', () => {
    const db = new Database(':memory:')
    runMigrations(db, allMigrations)
    const tables = new Set(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    )
    assert.equal(tables.has('assets'), true)
    assert.equal(tables.has('asset_references'), true)
    assert.equal(tables.has('conversation_outbox'), false)
    assert.equal(tables.has('agent_runtime_bindings'), false)

    const checksums = db
      .prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE checksum IS NOT NULL`)
      .get() as { n: number }
    assert.equal(checksums.n, allMigrations.length)
    db.close()
  })

  it('schema registry lists conversation and asset ownership', () => {
    const tables = SCHEMA_REGISTRY.map((entry) => entry.table)
    assert.ok(tables.includes('conversation_threads'))
    assert.ok(tables.includes('assets'))
    assert.ok(tables.includes('asset_references'))
  })

  it('migration 062 host wrapper is registered', () => {
    const host = join(root, 'packages/database/src/migrations/assets-and-drop-dead-runtime.ts')
    const index = readFileSync(join(root, 'packages/database/src/migrations/all.ts'), 'utf8')
    assert.equal(existsSync(host), true)
    assert.match(index, /migration062AssetsAndDropDeadRuntimeTables/)
  })

  it('migration 063 adds project FKs and is registered', () => {
    const db = new Database(':memory:')
    runMigrations(db, allMigrations)
    for (const table of ['conversation_threads', 'drafts', 'planning_sessions', 'jobs']) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
        table: string
        from: string
      }>
      assert.ok(
        fks.some((fk) => fk.table === 'projects' && fk.from === 'project_id'),
        `${table} missing project_id FK`
      )
    }
    const host = join(root, 'packages/database/src/migrations/project-fk-and-asset-storage.ts')
    const index = readFileSync(join(root, 'packages/database/src/migrations/all.ts'), 'utf8')
    assert.equal(existsSync(host), true)
    assert.match(index, /migration063ProjectFkAndAssetStorageKeys/)
    db.close()
  })

  it('attachment writers use storage_key helpers', () => {
    const attachments = readFileSync(join(root, 'src/server/conversation/attachments.ts'), 'utf8')
    const paths = readFileSync(join(root, 'src/server/data-paths.ts'), 'utf8')
    assert.match(attachments, /attachmentStorageKey/)
    assert.match(paths, /resolveAssetStoragePath/)
    assert.match(paths, /attachmentStorageKey/)
  })
})
