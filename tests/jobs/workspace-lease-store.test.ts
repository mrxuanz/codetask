import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import {
  acquireWorkspaceLease,
  findWorkspaceLeaseConflict,
  normalizeWorkspaceLeasePath,
  reclaimStaleWorkspaceLeasesOnStartup,
  releaseWorkspaceLeaseForOwner,
  resetWorkspaceLeaseStateForTests,
  workspacePathsConflict
} from '../../src/server/legacy-control-plane/workspace-lease-store'

let dataDir = ''
let workspaceRoot = ''

async function setup(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-ws-lease-'))
  workspaceRoot = join(dataDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  await resetAppContextForTests()
  resetWorkspaceLeaseStateForTests()
  bootstrapRuntime({ dataDir })
}

async function teardown(): Promise<void> {
  await resetAppContextForTests()
  resetWorkspaceLeaseStateForTests()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

test('workspacePathsConflict treats same, parent, and child paths as conflicts', () => {
  const root = 'C:/proj'
  const child = 'C:/proj/src'
  assert.equal(workspacePathsConflict(root, root), true)
  assert.equal(workspacePathsConflict(root, child), true)
  assert.equal(workspacePathsConflict(child, root), true)
  assert.equal(workspacePathsConflict('C:/other', root), false)
})

test('acquireWorkspaceLease is exclusive across owners for overlapping paths', async () => {
  await setup()
  try {
    const root = normalizeWorkspaceLeasePath(workspaceRoot)
    const childDir = join(workspaceRoot, 'pkg')
    mkdirSync(childDir, { recursive: true })
    const child = normalizeWorkspaceLeasePath(childDir)

    const first = acquireWorkspaceLease({
      workspacePath: root,
      ownerKind: 'conversation',
      ownerId: 'thread-a'
    })
    assert.ok(first)

    const childAttempt = acquireWorkspaceLease({
      workspacePath: child,
      ownerKind: 'thread_job',
      ownerId: 'job-b'
    })
    assert.equal(childAttempt, null)

    const conflict = findWorkspaceLeaseConflict(child, {
      ownerKind: 'thread_job',
      ownerId: 'job-c'
    })
    assert.ok(conflict)
    assert.equal(conflict?.ownerKind, 'conversation')
    assert.equal(conflict?.ownerId, 'thread-a')

    releaseWorkspaceLeaseForOwner('conversation', 'thread-a')
    const afterRelease = acquireWorkspaceLease({
      workspacePath: child,
      ownerKind: 'thread_job',
      ownerId: 'job-b'
    })
    assert.ok(afterRelease)
  } finally {
    await teardown()
  }
})

test('reclaimStaleWorkspaceLeasesOnStartup releases leases from prior boot', async () => {
  await setup()
  try {
    const acquired = acquireWorkspaceLease({
      workspacePath: workspaceRoot,
      ownerKind: 'planner',
      ownerId: 'plan-1'
    })
    assert.ok(acquired)

    const client = (getDb() as ReturnType<typeof getDb> & { $client?: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).$client
    assert.ok(client)
    client.prepare(`UPDATE workspace_leases SET boot_id = ? WHERE id = ?`).run(
      'stale-boot-id',
      acquired.leaseId
    )

    const reclaimed = reclaimStaleWorkspaceLeasesOnStartup()
    assert.equal(reclaimed, 1)

    const conflict = findWorkspaceLeaseConflict(workspaceRoot)
    assert.equal(conflict, null)
  } finally {
    await teardown()
  }
})

test('BEGIN IMMEDIATE acquire path uses normalized realpath', async () => {
  await setup()
  try {
    const acquired = acquireWorkspaceLease({
      workspacePath: workspaceRoot,
      ownerKind: 'conversation',
      ownerId: 'thread-1'
    })
    assert.ok(acquired)
    const rows = getDb()
      .select()
      .from((await import('../../src/server/db/schema')).workspaceLeases)
      .all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.canonicalPath, normalizeWorkspaceLeasePath(workspaceRoot))
  } finally {
    await teardown()
  }
})
