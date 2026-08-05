/**
 * Batch I architecture gates — historical cleanup inventory + dead table drops.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  BATCH_I_ABSENT_TABLES,
  BATCH_I_DEFERRED_LEGACY_TABLES,
  SCHEMA_REGISTRY
} from '@codetask/database'
import { allMigrations } from '../../src/server/db/migrations'
import { runMigrations } from '@codetask/database'

const root = join(import.meta.dirname, '../..')

describe('architecture gates — Batch I', () => {
  it('fresh migrate drops backup/marker and legacy thread tables', () => {
    const db = new Database(':memory:')
    runMigrations(db, allMigrations)
    const tables = new Set(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    )
    for (const name of BATCH_I_ABSENT_TABLES) {
      assert.equal(tables.has(name), false, `${name} should be absent`)
    }
    assert.deepEqual([...BATCH_I_DEFERRED_LEGACY_TABLES], [])
    assert.equal(tables.has('threads'), false)
    assert.equal(tables.has('thread_messages'), false)
    assert.equal(tables.has('conversation_threads'), true)
    db.close()
  })

  it('migration 064/065 are registered in @codetask/database allMigrations', () => {
    const mig064 = join(root, 'packages/database/src/migrations/drop-backup-and-marker-tables.ts')
    const mig065 = join(root, 'packages/database/src/migrations/drop-legacy-thread-tables.ts')
    const index = readFileSync(join(root, 'packages/database/src/migrations/all.ts'), 'utf8')
    assert.equal(existsSync(mig064), true)
    assert.equal(existsSync(mig065), true)
    assert.match(index, /migration064DropBackupAndMarkerTables/)
    assert.match(index, /migration065DropLegacyThreadTables/)
  })

  it('schema registry does not list threads as live tables', () => {
    assert.equal(
      SCHEMA_REGISTRY.some(
        (entry) => entry.table === 'threads' || entry.table === 'thread_messages'
      ),
      false
    )
  })

  it('janitor/deletion/purge do not import drizzle threads tables', () => {
    for (const rel of [
      'src/server/retention/janitor.ts',
      'src/server/retention/purge.ts',
      'src/server/infra/deletion-coordinator.ts'
    ]) {
      const source = readFileSync(join(root, rel), 'utf8')
      assert.doesNotMatch(source, /\bthreadMessages\b/)
      assert.doesNotMatch(source, /\{[^}]*\bthreads\b[^}]*\}\s*from\s+['"].*db\/schema/)
      assert.doesNotMatch(source, /from\s+['"].*db\/schema['"][^\n]*\bthreads\b/)
    }
    const janitor = readFileSync(join(root, 'src/server/retention/janitor.ts'), 'utf8')
    assert.match(janitor, /conversation_threads/)
    assert.equal(existsSync(join(root, 'src/server/conversation/messages.ts')), false)
  })

  it('src/renderer shell is gone; apps/web owns UI', () => {
    assert.equal(existsSync(join(root, 'src/renderer')), false)
    assert.equal(existsSync(join(root, 'apps/web/src/main.ts')), true)
  })

  it('provider concrete ownership is packages/provider-runtime-node (import graph)', () => {
    assert.equal(existsSync(join(root, 'packages/provider-runtime-node/src/index.ts')), true)
    assert.equal(
      existsSync(join(root, 'packages/provider-runtime-node/src/providers/access.ts')),
      true
    )

    const shim = readFileSync(join(root, 'src/server/providers/access.ts'), 'utf8')
    assert.match(shim, /export \* from '@codetask\/provider-runtime-node\/providers\/access'/)

    // Host-facing provider entry must re-export the package, not re-implement drivers.
    const providersIndex = readFileSync(join(root, 'src/server/providers/index.ts'), 'utf8')
    assert.match(providersIndex, /@codetask\/provider-runtime-node/)
    assert.doesNotMatch(providersIndex, /\bclass\s+\w+Driver\b/)

    // Concrete driver modules live under the package, not as large src implementations.
    for (const rel of [
      'packages/provider-runtime-node/src/providers/claude/driver.ts',
      'packages/provider-runtime-node/src/providers/codex/driver.ts',
      'packages/provider-runtime-node/src/providers/cursor/driver.ts',
      'packages/provider-runtime-node/src/providers/opencode/driver.ts'
    ]) {
      assert.equal(existsSync(join(root, rel)), true, `${rel} must exist`)
      const source = readFileSync(join(root, rel), 'utf8')
      assert.doesNotMatch(
        source,
        /^export \* from /,
        `${rel} should be the concrete implementation`
      )
    }
  })
})
