import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  bootstrapRuntime,
  resetAppContextForTests
} from '../../src/server/bootstrap'
import { createAppConfig } from '../../src/server/config/app-config'
import {
  detectSandboxReadCapabilities,
  resetSandboxReadCapabilitiesCache,
  setSandboxReadCapabilitiesForTest
} from '../../src/server/reference-corpus/sandbox-capabilities'
import {
  projectTaskReadGrants,
  readGrantsToReadRoots
} from '../../src/server/reference-corpus/read-grants'
import { buildJobReferenceManifest } from '../../src/shared/job-references'

test('createAppConfig defaults singleFileAllowlist to false and accepts override', () => {
  assert.equal(createAppConfig().sandbox.singleFileAllowlist, false)
  assert.equal(
    createAppConfig({ sandbox: { singleFileAllowlist: true } }).sandbox.singleFileAllowlist,
    true
  )
})

test('detectSandboxReadCapabilities defaults to directory-only projection', () => {
  resetSandboxReadCapabilitiesCache()
  try {
    const caps = detectSandboxReadCapabilities()
    assert.equal(caps.readRootMode, 'directory_only')
    assert.equal(caps.singleFileAllowlist, false)
    assert.equal(caps.platform, process.platform)
    assert.equal(typeof caps.nativeSandboxAvailable, 'boolean')
  } finally {
    resetSandboxReadCapabilitiesCache()
  }
})

test('detectSandboxReadCapabilities reads AppConfig.sandbox.singleFileAllowlist', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-sandbox-caps-'))
  resetSandboxReadCapabilitiesCache()
  try {
    bootstrapRuntime({
      dataDir,
      mode: 'desktop',
      config: { sandbox: { singleFileAllowlist: true } }
    })
    resetSandboxReadCapabilitiesCache()
    const caps = detectSandboxReadCapabilities()
    assert.equal(caps.singleFileAllowlist, true)
  } finally {
    resetSandboxReadCapabilitiesCache()
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('single-file allowlist uses exact file path when enabled', () => {
  resetSandboxReadCapabilitiesCache()
  setSandboxReadCapabilitiesForTest({
    platform: 'linux',
    nativeSandboxAvailable: true,
    readRootMode: 'directory_only',
    singleFileAllowlist: true
  })

  const manifest = buildJobReferenceManifest({
    jobId: 'ds-1',
    threadId: 'thread-1',
    references: [
      {
        id: 'ref-file',
        name: 'notes.md',
        kind: 'file',
        mimeType: 'text/markdown',
        description: 'notes',
        resolvedPath: '/data/corpus/notes.md',
        source: 'local_corpus',
        inWorkspace: false,
        requiresDescription: true,
        assetUrl: ''
      }
    ]
  })

  const grants = projectTaskReadGrants({
    workspaceRoot: '/workspace/project',
    manifest,
    taskReferenceIds: ['ref-file']
  })
  assert.equal(grants.length, 1)
  assert.deepEqual(grants[0], { kind: 'file', path: '/data/corpus/notes.md' })
  assert.deepEqual(readGrantsToReadRoots(grants), ['/data/corpus/notes.md'])
  resetSandboxReadCapabilitiesCache()
})

test('directory-only mode mounts parent dir for local_corpus file grants', () => {
  resetSandboxReadCapabilitiesCache()
  setSandboxReadCapabilitiesForTest({
    platform: 'linux',
    nativeSandboxAvailable: true,
    readRootMode: 'directory_only',
    singleFileAllowlist: false
  })

  const manifest = buildJobReferenceManifest({
    jobId: 'ds-1',
    threadId: 'thread-1',
    references: [
      {
        id: 'ref-file',
        name: 'notes.md',
        kind: 'file',
        mimeType: 'text/markdown',
        description: 'notes',
        resolvedPath: '/data/corpus/notes.md',
        source: 'local_corpus',
        inWorkspace: false,
        requiresDescription: true,
        assetUrl: ''
      }
    ]
  })

  const grants = projectTaskReadGrants({
    workspaceRoot: '/workspace/project',
    manifest,
    taskReferenceIds: ['ref-file']
  })
  assert.equal(grants.length, 1)
  assert.deepEqual(grants[0], { kind: 'directory', path: '/data/corpus' })
  resetSandboxReadCapabilitiesCache()
})
