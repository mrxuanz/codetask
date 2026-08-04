import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFileSecretKeyProvider, keyBytesToHex } from '@codetask/service-bootstrap'

describe('FileSecretKeyProvider', () => {
  it('persists installation key under dataDir/secrets and reuses it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'codetask-secret-'))
    try {
      const authSecretHex = 'a'.repeat(64)
      const a = createFileSecretKeyProvider({ dataDir, authSecretHex })
      const first = a.getOrCreateInstallationKeySync()
      assert.equal(keyBytesToHex(first), authSecretHex)

      const keyPath = join(dataDir, 'secrets', 'installation.key')
      assert.equal(readFileSync(keyPath, 'utf8').trim(), authSecretHex)

      const b = createFileSecretKeyProvider({ dataDir, authSecretHex: 'b'.repeat(64) })
      const second = b.getOrCreateInstallationKeySync()
      assert.equal(keyBytesToHex(second), authSecretHex)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('reads --master-key-file when provided', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'codetask-secret-'))
    const keyDir = mkdtempSync(join(tmpdir(), 'codetask-master-'))
    try {
      const masterPath = join(keyDir, 'master.key')
      const masterHex = 'c'.repeat(64)
      writeFileSync(masterPath, `${masterHex}\n`, 'utf8')

      const provider = createFileSecretKeyProvider({
        dataDir,
        authSecretHex: 'd'.repeat(64),
        masterKeyFile: masterPath
      })
      assert.equal(keyBytesToHex(provider.getOrCreateInstallationKeySync()), masterHex)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(keyDir, { recursive: true, force: true })
    }
  })

  it('hashes non-hex master key file contents', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'codetask-secret-'))
    const keyDir = mkdtempSync(join(tmpdir(), 'codetask-master-'))
    try {
      mkdirSync(keyDir, { recursive: true })
      const masterPath = join(keyDir, 'master.txt')
      writeFileSync(masterPath, 'recovery-passphrase\n', 'utf8')
      const provider = createFileSecretKeyProvider({
        dataDir,
        authSecretHex: 'e'.repeat(64),
        masterKeyFile: masterPath
      })
      const bytes = provider.getOrCreateInstallationKeySync()
      assert.equal(bytes.byteLength, 32)
      assert.notEqual(keyBytesToHex(bytes), 'e'.repeat(64))
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(keyDir, { recursive: true, force: true })
    }
  })
})
