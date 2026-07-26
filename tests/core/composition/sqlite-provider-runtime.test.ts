import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  RUNTIME_ADAPTER_PROTECTED_ENTRY,
  RuntimeAdapter
} from '../../../src/server/adapters/runtime/index.ts'
import { createApplication } from '../../../src/server/composition/create-application.ts'

describe('sqlite composition providers + runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codetask-sqlite-provider-runtime-'))
  const sqlitePath = join(dir, 'kernel.sqlite')
  const app = createApplication({ mode: 'sqlite', sqlitePath })

  after(() => {
    app.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves Wave 7C providers including fake and codex', () => {
    const fake = app.providers.get('fake')
    const codex = app.providers.get('codex')
    assert.ok(fake)
    assert.ok(codex)
    assert.equal(fake.code, 'fake')
    assert.equal(codex.code, 'codex')
  })

  it('wires dry-run RuntimeAdapter with protected entry', async () => {
    assert.ok(app.runtime instanceof RuntimeAdapter)
    const runtime = app.runtime as RuntimeAdapter
    assert.equal(runtime.protectedEntry, RUNTIME_ADAPTER_PROTECTED_ENTRY)

    const { turnId } = await runtime.openTurn({
      jobId: 'job-sqlite-runtime',
      providerCode: 'fake'
    })
    assert.match(turnId, /^rt-/)
  })
})
