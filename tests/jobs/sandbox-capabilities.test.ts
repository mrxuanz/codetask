import assert from 'node:assert/strict'
import test from 'node:test'
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
