import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  StorageValidationNonceRepository,
  validateStorageTarget
} from '../../apps/service/src/storage-validation'

test('storage validation rejects relative, non-empty, forbidden, and symlink targets', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-storage-validation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(
    validateStorageTarget({ path: 'relative/data', minFreeBytes: 0 }).issue,
    'path_not_absolute'
  )

  const nonEmpty = join(root, 'non-empty')
  mkdirSync(nonEmpty)
  writeFileSync(join(nonEmpty, 'foreign.txt'), 'foreign')
  assert.equal(validateStorageTarget({ path: nonEmpty, minFreeBytes: 0 }).issue, 'path_not_empty')

  assert.equal(
    validateStorageTarget({ path: root, forbiddenRoots: [root], minFreeBytes: 0 }).issue,
    'path_forbidden_root'
  )

  if (process.platform !== 'win32') {
    const real = join(root, 'real')
    const link = join(root, 'link')
    mkdirSync(real)
    symlinkSync(real, link, 'dir')
    assert.equal(validateStorageTarget({ path: link, minFreeBytes: 0 }).issue, 'path_symlink')
  }
})

test('validation nonce is single-use and bound to the canonical path', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-storage-validation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const grants = new StorageValidationNonceRepository()
  const path = join(root, 'data')
  const result = validateStorageTarget({ path, minFreeBytes: 0, nonceRepository: grants })
  assert.equal(result.ok, true)
  assert.ok(result.nonce)
  assert.equal(grants.consume(result.nonce!, join(root, 'other')), false)
  assert.equal(grants.consume(result.nonce!, result.canonicalPath), false)

  const second = validateStorageTarget({ path, minFreeBytes: 0, nonceRepository: grants })
  assert.equal(grants.consume(second.nonce!, second.canonicalPath), true)
  assert.equal(grants.consume(second.nonce!, second.canonicalPath), false)
})

test('validation nonce repository evicts only the oldest grant at capacity', () => {
  const grants = new StorageValidationNonceRepository(2)
  const first = grants.issue('/first')
  const second = grants.issue('/second')

  assert.equal(grants.consume(second, '/second'), true)

  const replacementSecond = grants.issue('/second')
  const third = grants.issue('/third')
  assert.equal(grants.consume(first, '/first'), false)
  assert.equal(grants.consume(replacementSecond, '/second'), true)
  assert.equal(grants.consume(third, '/third'), true)
})
