import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeReleaseArtifacts } from '../normalize-release-artifacts.mjs'

const repositoryVersion = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version

test('linux amd64 accepts electron-builder AppImage x86_64 and deb amd64 names', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-artifacts-'))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, `codetask-${repositoryVersion}-linux-x86_64.AppImage`), 'app')
    writeFileSync(join(root, `codetask-${repositoryVersion}-linux-amd64.deb`), 'deb')
    const artifacts = normalizeReleaseArtifacts({
      distDir: root,
      platform: 'linux-amd64',
      version: repositoryVersion
    })
    assert.deepEqual(artifacts, [
      `codetask-${repositoryVersion}-linux-amd64.AppImage`,
      `codetask-${repositoryVersion}-linux-amd64.deb`
    ])
    assert.equal(existsSync(join(root, artifacts[0])), true)
    assert.equal(
      existsSync(join(root, `codetask-${repositoryVersion}-linux-x86_64.AppImage`)),
      false
    )
    assert.equal(existsSync(join(root, `codetask-${repositoryVersion}-linux-amd64.deb`)), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Windows installer, portable executable and archive keep their suffixes', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-artifacts-windows-'))
  try {
    for (const suffix of ['-portable.exe', '-setup.exe', '.zip']) {
      writeFileSync(join(root, `codetask-${repositoryVersion}-windows-x64${suffix}`), suffix)
    }
    const artifacts = normalizeReleaseArtifacts({
      distDir: root,
      platform: 'windows-amd64',
      version: repositoryVersion
    })
    assert.deepEqual(artifacts, [
      `codetask-${repositoryVersion}-windows-amd64-portable.exe`,
      `codetask-${repositoryVersion}-windows-amd64-setup.exe`,
      `codetask-${repositoryVersion}-windows-amd64.zip`
    ])
    for (const artifact of artifacts) assert.equal(existsSync(join(root, artifact)), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('artifact normalization rejects a release version different from package.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-artifacts-version-'))
  try {
    writeFileSync(join(root, `codetask-${repositoryVersion}-linux-x86_64.AppImage`), 'app')
    assert.throws(
      () =>
        normalizeReleaseArtifacts({
          distDir: root,
          platform: 'linux-amd64',
          version: '9.9.9'
        }),
      new RegExp(`release_artifacts\\.version_mismatch:9\\.9\\.9:${repositoryVersion}`)
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
