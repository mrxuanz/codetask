import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveFolderSelection } from '../../src/server/fs'

test('folder selection returns a canonical existing directory without creating it', () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-folder-select-'))
  try {
    const result = resolveFolderSelection(root, false)
    assert.equal(result.path, realpathSync.native(root))
    assert.equal(result.created, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('folder selection creates a missing directory only when explicitly requested', () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-folder-create-'))
  try {
    const target = join(root, 'new', 'workspace')
    const result = resolveFolderSelection(target, true)
    assert.equal(result.path, realpathSync.native(target))
    assert.equal(result.created, true)
    assert.equal(resolveFolderSelection(target, false).created, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('folder selection rejects regular files', () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-folder-file-'))
  try {
    const target = join(root, 'not-a-folder.txt')
    writeFileSync(target, 'x')
    assert.throws(() => resolveFolderSelection(target, false))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
