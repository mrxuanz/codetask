import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadNodeAuthSecret } from '../../src/standalone/app-secret'

function fixture(t: test.TestContext): { root: string; secretPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'codetask-node-secret-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, secretPath: join(root, 'auth-secret') }
}

test('standalone Node creates and reuses a file-backed auth secret', async (t) => {
  const f = fixture(t)
  const first = await loadNodeAuthSecret(
    { mode: 'server', bootstrapSecretPath: f.secretPath },
    { credentialPath: null }
  )
  const second = await loadNodeAuthSecret(
    { mode: 'server', bootstrapSecretPath: f.secretPath },
    { credentialPath: null }
  )

  assert.equal(first.value, second.value)
  assert.match(readFileSync(f.secretPath, 'utf8'), /^[a-f0-9]{64}$/u)
  assert.equal(first.provider.describeStorage().kind, 'fallback_file')
  if (process.platform !== 'win32') {
    assert.equal(statSync(f.secretPath).mode & 0o777, 0o600)
  }
})

test('standalone Node fails clearly on an Electron-encrypted shared secret', async (t) => {
  const f = fixture(t)
  writeFileSync(
    f.secretPath,
    `${JSON.stringify({ formatVersion: 1, ciphertext: 'electron-safe-storage' })}\n`,
    'utf8'
  )

  await assert.rejects(
    loadNodeAuthSecret(
      { mode: 'server', bootstrapSecretPath: f.secretPath },
      { credentialPath: null }
    ),
    /protected by Electron OS storage/
  )
})
