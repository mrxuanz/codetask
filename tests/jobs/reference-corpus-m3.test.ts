import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { applyMigrations } from '../../src/server/db/migrations'
import {
  projectTaskReadGrants,
  readGrantsToReadRoots
} from '../../src/server/reference-corpus/read-grants.ts'
import { buildJobReferenceManifest } from '../../src/shared/job-references.ts'

test('migration 018 creates draft_references table', () => {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  applyMigrations(sqlite)

  const tables = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as Array<{ name: string }>
  assert.ok(tables.some((t) => t.name === 'draft_references'))

  // After P10 (026), planning metadata lives on thread_jobs; design_sessions is dropped.
  const cols = sqlite.prepare(`PRAGMA table_info(thread_jobs)`).all() as Array<{ name: string }>
  assert.ok(cols.some((col) => col.name === 'manifest_revision'))
  assert.ok(cols.some((col) => col.name === 'corpus_revision'))
  assert.equal(
    tables.some((t) => t.name === 'design_sessions'),
    false
  )

  sqlite.close()
})

test('projectTaskReadGrants mounts attachment parent dir only for assigned ref', () => {
  const attA = '/data/attachments/thread-1/att-a/file.png'
  const attB = '/data/attachments/thread-1/att-b/other.png'
  const manifest = buildJobReferenceManifest({
    jobId: 'ds-1',
    threadId: 'thread-1',
    references: [
      {
        id: 'att-a',
        name: 'a.png',
        kind: 'image',
        mimeType: 'image/png',
        description: 'layout',
        resolvedPath: attA,
        source: 'attachment',
        inWorkspace: false,
        requiresDescription: true,
        assetUrl: ''
      },
      {
        id: 'att-b',
        name: 'b.png',
        kind: 'image',
        mimeType: 'image/png',
        description: 'other',
        resolvedPath: attB,
        source: 'attachment',
        inWorkspace: false,
        requiresDescription: true,
        assetUrl: ''
      }
    ]
  })

  const grants = projectTaskReadGrants({
    workspaceRoot: '/workspace/project',
    manifest,
    taskReferenceIds: ['att-a']
  })
  assert.equal(grants.length, 1)
  assert.equal(grants[0]?.kind, 'directory')
  assert.equal((grants[0] as { path: string }).path, '/data/attachments/thread-1/att-a')

  const roots = readGrantsToReadRoots(grants)
  assert.deepEqual(roots, ['/data/attachments/thread-1/att-a'])
})

test('projectTaskReadGrants skips inWorkspace local corpus entries', () => {
  const manifest = buildJobReferenceManifest({
    jobId: 'ds-1',
    threadId: 'thread-1',
    references: [
      {
        id: 'ref-in',
        name: 'in-repo docs',
        kind: 'directory',
        mimeType: 'application/octet-stream',
        description: 'internal docs',
        resolvedPath: '/workspace/project/docs',
        source: 'local_corpus',
        inWorkspace: true,
        requiresDescription: false,
        assetUrl: ''
      },
      {
        id: 'ref-out',
        name: 'auth lib',
        kind: 'directory',
        mimeType: 'application/octet-stream',
        description: 'external auth',
        resolvedPath: '/data/repos/auth-service',
        source: 'local_corpus',
        inWorkspace: false,
        requiresDescription: false,
        assetUrl: ''
      }
    ]
  })

  const grants = projectTaskReadGrants({
    workspaceRoot: '/workspace/project',
    manifest,
    taskReferenceIds: ['ref-in', 'ref-out']
  })
  assert.equal(grants.length, 1)
  assert.equal((grants[0] as { path: string }).path, '/data/repos/auth-service')
})
