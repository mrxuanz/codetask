import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSetupShell } from '../../src/main/setup-shell'

test('server mode storage setup prints setup token and requires it on bootstrap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-storage-setup-server-token-'))
  const candidate = join(root, 'data')
  const storage = {
    phase: 'selection_required',
    dataDir: candidate,
    source: 'candidate'
  } as const

  try {
    const app = createSetupShell({ storage, isDev: true, setupTokenRequired: true })
    const response = await app.request('/api/auth/bootstrap')
    assert.equal(response.ok, true)
    const body = (await response.json()) as {
      data?: { setupTokenRequired?: boolean; storagePhase?: string }
    }
    assert.equal(body.data?.setupTokenRequired, true)
    assert.equal(body.data?.storagePhase, 'selection_required')
    const serverSource = readFileSync(new URL('../../src/main/server.ts', import.meta.url), 'utf8')
    assert.match(serverSource, /announceSetupToken\(gate\)/)
    assert.match(serverSource, /setupTokenRequired:\s*cli\.mode === 'server'/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('storage setup startup exposes a missing default candidate without creating it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-storage-setup-server-'))
  const candidate = join(root, 'data')
  const storage = {
    phase: 'selection_required',
    dataDir: candidate,
    source: 'candidate'
  } as const

  try {
    assert.equal(existsSync(candidate), false)
    const app = createSetupShell({ storage, isDev: true })
    const response = await app.request('/api/system/storage/bootstrap')
    assert.equal(response.ok, true)
    const body = (await response.json()) as {
      data?: { phase?: string; defaultCandidate?: string }
    }
    assert.equal(body.data?.phase, 'selection_required')
    assert.equal(body.data?.defaultCandidate, candidate)
    assert.equal(existsSync(candidate), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
