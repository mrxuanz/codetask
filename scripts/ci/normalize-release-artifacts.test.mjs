import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeReleaseArtifacts } from '../normalize-release-artifacts.mjs'

test('linux amd64 accepts electron-builder AppImage x86_64 and deb amd64 names', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-artifacts-'))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'codetask-0.1.0-beta-linux-x86_64.AppImage'), 'app')
    writeFileSync(join(root, 'codetask-0.1.0-beta-linux-amd64.deb'), 'deb')
    const artifacts = normalizeReleaseArtifacts({
      distDir: root,
      platform: 'linux-amd64',
      version: '0.1.0-beta'
    })
    assert.deepEqual(artifacts, [
      'codetask-0.1.0-beta-linux-amd64.AppImage',
      'codetask-0.1.0-beta-linux-amd64.deb'
    ])
    assert.equal(existsSync(join(root, artifacts[0])), true)
    assert.equal(existsSync(join(root, 'codetask-0.1.0-beta-linux-x86_64.AppImage')), false)
    assert.equal(existsSync(join(root, 'codetask-0.1.0-beta-linux-amd64.deb')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows installer, portable executable and archive keep their suffixes', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-artifacts-windows-'))
  try {
    for (const suffix of ['-portable.exe', '-setup.exe', '.zip']) {
      writeFileSync(join(root, `codetask-0.1.0-beta-windows-x64${suffix}`), suffix)
    }
    const artifacts = normalizeReleaseArtifacts({
      distDir: root,
      platform: 'windows-amd64',
      version: '0.1.0-beta'
    })
    assert.deepEqual(artifacts, [
      'codetask-0.1.0-beta-windows-amd64-portable.exe',
      'codetask-0.1.0-beta-windows-amd64-setup.exe',
      'codetask-0.1.0-beta-windows-amd64.zip'
    ])
    for (const artifact of artifacts) assert.equal(existsSync(join(root, artifact)), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
