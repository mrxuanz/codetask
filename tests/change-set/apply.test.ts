import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import { projects } from '../../src/server/db/schema'
import {
  applyChangeSet,
  cancelChangeSet,
  createChangeSet,
  getChangeSet,
  markChangeSetReady
} from '../../src/server/change-set/service'
import {
  acquireWorkspaceLease,
  releaseWorkspaceLease
} from '../../src/server/legacy-control-plane/workspace-lease-store'
import { changeSetPatchPath } from '../../src/server/change-set/patch'

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir, windowsHide: true })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
    windowsHide: true
  })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, windowsHide: true })
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: dir, windowsHide: true })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, windowsHide: true })
}

test('mark ready + apply succeeds when base HEAD unchanged', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-cs-apply-'))
  const workspace = join(dataDir, 'ws')
  initGitRepo(workspace)

  bootstrapRuntime({ dataDir })
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const username = 'cs-apply-user'
  const projectId = 'proj-cs-apply'

  getDb()
    .insert(projects)
    .values({
      id: projectId,
      username,
      title: 'Apply Project',
      workspaceRoot: workspace,
      createdAt: now,
      updatedAt: now
    })
    .run()

  const accepted = await createChangeSet(username, { projectId })
  const created = await getChangeSet(username, accepted.changeSetId)
  assert.ok(created.worktreePath)

  writeFileSync(join(created.worktreePath!, 'README.md'), '# changed\n', 'utf8')
  writeFileSync(join(created.worktreePath!, 'new-file.txt'), 'hello\n', 'utf8')

  const ready = await markChangeSetReady(username, accepted.changeSetId, created.stateRevision)
  assert.equal(ready.status, 'ready_to_apply')
  assert.ok(ready.patchHash)

  const applied = await applyChangeSet(username, accepted.changeSetId, ready.stateRevision)
  assert.equal(applied.status, 'applied')
  assert.equal(applied.worktreePath, null)
  assert.equal(
    readFileSync(join(workspace, 'README.md'), 'utf8').replace(/\r\n/g, '\n'),
    '# changed\n'
  )
  assert.equal(
    readFileSync(join(workspace, 'new-file.txt'), 'utf8').replace(/\r\n/g, '\n'),
    'hello\n'
  )
})

test('apply enters needs_resolution when base HEAD changed', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-cs-base-'))
  const workspace = join(dataDir, 'ws')
  initGitRepo(workspace)

  bootstrapRuntime({ dataDir })
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const username = 'cs-base-user'
  const projectId = 'proj-cs-base'

  getDb()
    .insert(projects)
    .values({
      id: projectId,
      username,
      title: 'Base Project',
      workspaceRoot: workspace,
      createdAt: now,
      updatedAt: now
    })
    .run()

  const accepted = await createChangeSet(username, { projectId })
  const created = await getChangeSet(username, accepted.changeSetId)
  writeFileSync(join(created.worktreePath!, 'only-in-cs.txt'), 'cs\n', 'utf8')

  const ready = await markChangeSetReady(username, accepted.changeSetId, created.stateRevision)
  assert.equal(ready.status, 'ready_to_apply')

  // Diverging main workspace commit after Change Set was created.
  writeFileSync(join(workspace, 'main-only.txt'), 'main\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: workspace, windowsHide: true })
  execFileSync('git', ['commit', '-m', 'diverge'], { cwd: workspace, windowsHide: true })

  const result = await applyChangeSet(username, accepted.changeSetId, ready.stateRevision)
  assert.equal(result.status, 'needs_resolution')
  assert.equal(result.lastError?.code, 'change_set.base_changed')
  assert.equal(existsSync(join(workspace, 'only-in-cs.txt')), false)
})

test('apply refuses a patch artifact whose hash no longer matches', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-cs-integrity-'))
  const workspace = join(dataDir, 'ws')
  initGitRepo(workspace)

  bootstrapRuntime({ dataDir })
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const username = 'cs-integrity-user'
  const projectId = 'proj-cs-integrity'
  getDb()
    .insert(projects)
    .values({
      id: projectId,
      username,
      title: 'Integrity Project',
      workspaceRoot: workspace,
      createdAt: now,
      updatedAt: now
    })
    .run()

  const accepted = await createChangeSet(username, { projectId })
  const created = await getChangeSet(username, accepted.changeSetId)
  writeFileSync(join(created.worktreePath!, 'README.md'), '# intended\n', 'utf8')
  const ready = await markChangeSetReady(username, accepted.changeSetId, created.stateRevision)
  writeFileSync(
    changeSetPatchPath(dataDir, accepted.changeSetId),
    'malicious or corrupted patch\n',
    'utf8'
  )

  const result = await applyChangeSet(username, accepted.changeSetId, ready.stateRevision)
  assert.equal(result.status, 'needs_resolution')
  assert.equal(result.lastError?.code, 'change_set.patch_integrity_failed')
  assert.equal(readFileSync(join(workspace, 'README.md'), 'utf8'), '# test\n')
})

test('apply rejects when exclusive workspace lease is held', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-cs-lease-'))
  const workspace = join(dataDir, 'ws')
  initGitRepo(workspace)

  bootstrapRuntime({ dataDir })
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const username = 'cs-lease-user'
  const projectId = 'proj-cs-lease'

  getDb()
    .insert(projects)
    .values({
      id: projectId,
      username,
      title: 'Lease Project',
      workspaceRoot: workspace,
      createdAt: now,
      updatedAt: now
    })
    .run()

  const accepted = await createChangeSet(username, { projectId })
  const created = await getChangeSet(username, accepted.changeSetId)
  writeFileSync(join(created.worktreePath!, 'README.md'), '# leased\n', 'utf8')
  const ready = await markChangeSetReady(username, accepted.changeSetId, created.stateRevision)

  const jobLease = acquireWorkspaceLease({
    workspacePath: workspace,
    ownerKind: 'thread_job',
    ownerId: 'job-holding-lease'
  })
  assert.ok(jobLease)

  await assert.rejects(
    () => applyChangeSet(username, accepted.changeSetId, ready.stateRevision),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Workspace is busy/i)
      return true
    }
  )

  releaseWorkspaceLease(jobLease.leaseId)
  await cancelChangeSet(username, accepted.changeSetId)
})
