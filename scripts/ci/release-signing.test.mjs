import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { verifyReleaseSigning } from '../verify-release-signing.mjs'

const credentialCheck = resolve('scripts/check-release-signing.mjs')

function runCredentialCheck(platform, env = {}) {
  return spawnSync(process.execPath, [credentialCheck, '--platform', platform], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env }
  })
}

test('release signing credentials fail closed for macOS and Windows', () => {
  const mac = runCredentialCheck('macos-arm64')
  assert.notEqual(mac.status, 0)
  assert.match(mac.stderr, /release_signing\.missing:macos-arm64/u)

  const windows = runCredentialCheck('windows-amd64')
  assert.notEqual(windows.status, 0)
  assert.match(windows.stderr, /release_signing\.missing:windows-amd64/u)
})

test('release signing credential check accepts complete platform-scoped values', () => {
  const mac = runCredentialCheck('macos-arm64', {
    CSC_LINK: 'certificate',
    CSC_KEY_PASSWORD: 'password',
    APPLE_ID: 'release@example.invalid',
    APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
    APPLE_TEAM_ID: 'ABCDE12345'
  })
  assert.equal(mac.status, 0, mac.stderr)

  const windows = runCredentialCheck('windows-amd64', {
    CSC_LINK: 'certificate',
    CSC_KEY_PASSWORD: 'password'
  })
  assert.equal(windows.status, 0, windows.stderr)
})

test('release signing checks reject unknown platforms and mark Linux not required', () => {
  const unknown = runCredentialCheck('window-amd64')
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stderr, /release_signing\.invalid_platform/u)

  const root = mkdtempSync(join(tmpdir(), 'release-signing-linux-'))
  try {
    assert.deepEqual(verifyReleaseSigning({ distDir: root, platform: 'linux-amd64' }), {
      ok: true,
      platform: 'linux-amd64',
      signing: 'not-required',
      targets: []
    })
    assert.throws(
      () => verifyReleaseSigning({ distDir: root, platform: 'unknown' }),
      /release_signing\.invalid_platform/u
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
