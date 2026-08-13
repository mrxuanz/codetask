import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { MIGRATION_CONTENT_CHECKSUMS } from '../../packages/database/src/migrations/manifest'
import { migrationSourceChecksum } from '../../packages/database/src/migrations/content-checksum'

const migrationsRoot = join(import.meta.dirname, '../../packages/database/src/migrations')

test('published migration source content matches the committed checksum manifest', () => {
  for (const entry of MIGRATION_CONTENT_CHECKSUMS) {
    const source = readFileSync(join(migrationsRoot, entry.source), 'utf8')
    assert.equal(migrationSourceChecksum(source), entry.contentChecksum, `v${entry.version}`)
  }
})

test('migration source drift changes the normalized content checksum', () => {
  const entry = MIGRATION_CONTENT_CHECKSUMS[0]
  assert.ok(entry)
  const source = readFileSync(join(migrationsRoot, entry.source), 'utf8')
  assert.notEqual(
    migrationSourceChecksum(`${source}\n-- changed implementation\n`),
    entry.contentChecksum
  )
})
