import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolvePackagedServiceEntry } from '../../src/main/service-entry'

test('packaged service entry resolves from a main chunk directory', () => {
  const outMain = mkdtempSync(join(tmpdir(), 'codetask-service-entry-'))
  const chunks = join(outMain, 'chunks')
  const standalone = join(outMain, 'standalone.js')
  mkdirSync(chunks)
  writeFileSync(standalone, '')

  assert.equal(resolvePackagedServiceEntry(chunks), standalone)
})

test('packaged service entry still supports a non-chunked main output', () => {
  const outMain = mkdtempSync(join(tmpdir(), 'codetask-service-entry-flat-'))
  const standalone = join(outMain, 'standalone.js')
  writeFileSync(standalone, '')

  assert.equal(resolvePackagedServiceEntry(outMain), standalone)
})
