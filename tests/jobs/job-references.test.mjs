import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  buildJobReferenceManifest,
  collectFlatPlanReferenceIds,
  validateReferenceCoverage,
  validateTaskReferenceIds
} from '../../src/shared/job-references.ts'
import {
  assertManifestReferenceFilesExist,
  ReferenceFileMissingError,
  resolveAssignedReferenceLocalPaths
} from '../../src/server/jobs/reference-paths.ts'

test('validateReferenceCoverage requires image references to be assigned', () => {
  const manifest = buildJobReferenceManifest({
    jobId: 'job-1',
    threadId: 'thread-1',
    references: [
      {
        id: 'att-1',
        name: 'home.png',
        kind: 'image',
        mimeType: 'image/png',
        description: 'hero layout',
        relativePath: 'att-1.png',
        requiresDescription: true,
        assetUrl: '/api/threads/thread-1/attachments/att-1'
      },
      {
        id: 'notes.md',
        name: 'notes.md',
        kind: 'file',
        mimeType: 'text/markdown',
        description: '',
        relativePath: 'notes.md',
        requiresDescription: false,
        assetUrl: '/api/threads/thread-1/attachments/notes'
      }
    ]
  })

  const missing = validateReferenceCoverage(
    collectFlatPlanReferenceIds([{ referenceIds: ['att-1'] }]),
    manifest
  )
  assert.deepEqual(missing, [])

  const uncovered = validateReferenceCoverage(
    collectFlatPlanReferenceIds([{ referenceIds: [] }]),
    manifest
  )
  assert.equal(uncovered.length, 1)
  assert.match(uncovered[0], /home\.png/)
})

test('validateReferenceCoverage skips ignored references', () => {
  const manifest = buildJobReferenceManifest({
    jobId: 'job-1',
    threadId: 'thread-1',
    references: [
      {
        id: 'att-1',
        name: 'home.png',
        kind: 'image',
        mimeType: 'image/png',
        description: 'hero layout',
        relativePath: 'att-1.png',
        requiresDescription: true,
        assetUrl: '/api/threads/thread-1/attachments/att-1'
      }
    ],
    ignoredReferenceIds: ['att-1']
  })

  const errors = validateReferenceCoverage(new Set(), manifest)
  assert.deepEqual(errors, [])
})

test('validateTaskReferenceIds rejects unknown ids', () => {
  const manifest = buildJobReferenceManifest({
    jobId: 'job-1',
    threadId: 'thread-1',
    references: [
      {
        id: 'att-1',
        name: 'home.png',
        kind: 'image',
        mimeType: 'image/png',
        description: 'hero',
        relativePath: 'att-1.png',
        requiresDescription: true,
        assetUrl: '/api/threads/thread-1/attachments/att-1'
      }
    ]
  })
  assert.deepEqual(validateTaskReferenceIds(manifest, ['att-1']), [])
  assert.equal(validateTaskReferenceIds(manifest, ['missing'])[0], 'unknown referenceId "missing"')
})

test('assertManifestReferenceFilesExist validates on-disk files', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ref-manifest-'))
  const threadId = 'thread-ok'
  const attachmentsDir = join(dataDir, 'blobs', 'attachments', threadId)
  mkdirSync(attachmentsDir, { recursive: true })
  writeFileSync(join(attachmentsDir, 'att-1.png'), 'png')

  const manifest = buildJobReferenceManifest({
    jobId: 'job-1',
    threadId,
    references: [
      {
        id: 'att-1',
        name: 'home.png',
        kind: 'image',
        mimeType: 'image/png',
        description: 'hero',
        relativePath: 'att-1.png',
        requiresDescription: true,
        assetUrl: '/api/threads/thread-ok/attachments/att-1'
      }
    ]
  })

  assert.doesNotThrow(() => assertManifestReferenceFilesExist(dataDir, threadId, manifest))

  const broken = {
    ...manifest,
    references: [{ ...manifest.references[0], relativePath: 'missing.png' }]
  }
  assert.throws(
    () => assertManifestReferenceFilesExist(dataDir, threadId, broken),
    ReferenceFileMissingError
  )

  const paths = resolveAssignedReferenceLocalPaths(dataDir, threadId, manifest, ['att-1'])
  assert.equal(paths.size, 1)
  assert.match(paths.get('att-1') ?? '', /att-1\.png$/)
})
