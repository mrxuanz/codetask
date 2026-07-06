import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { ReferencePathError, resolveLocalCorpusPath } from '../../src/server/reference-corpus/paths'

test('resolveLocalCorpusPath accepts POSIX absolute paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-path-'))
  try {
    const resolved = resolveLocalCorpusPath(dir)
    assert.ok(resolved.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveLocalCorpusPath rejects relative paths', () => {
  assert.throws(() => resolveLocalCorpusPath('relative/not-absolute'), ReferencePathError)
})

test('resolveLocalCorpusPath expands tilde home', () => {
  const resolved = resolveLocalCorpusPath('~')
  assert.ok(resolved.length > 0)
})
