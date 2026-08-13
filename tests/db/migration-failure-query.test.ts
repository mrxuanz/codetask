import assert from 'node:assert/strict'
import test from 'node:test'
import { assertNoMigrationFailures } from '@codetask/database'

function failingDb(message: string): import('better-sqlite3').Database {
  return {
    prepare() {
      throw new Error(message)
    }
  } as unknown as import('better-sqlite3').Database
}

test('migration failure probe ignores only the historical missing-table condition', () => {
  assert.doesNotThrow(() =>
    assertNoMigrationFailures(failingDb('no such table: migration_failures'))
  )
  for (const message of [
    'SQLITE_CORRUPT: database disk image is malformed',
    'SQLITE_BUSY',
    'syntax error'
  ]) {
    assert.throws(
      () => assertNoMigrationFailures(failingDb(message)),
      new RegExp(message.split(':')[0])
    )
  }
})
