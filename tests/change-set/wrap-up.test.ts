import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import { projects } from '../../src/server/db/schema'
import { pruneTerminalChangeSetTrees } from '../../src/server/change-set/cleanup'
import {
  applyChangeSet,
  cancelChangeSet,
  createChangeSet,
  getChangeSet,
  markChangeSetReady,
  rebaseChangeSet
} from '../../src/server/change-set/service'
import { changeSetWorktreePath } from '../../src/server/change-set/paths'
import { execFileSync } from 'node:child_process'

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

test('non-git COW create / ready / apply', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-cs-cow-'))
  const workspace = join(dataDir, 'ws')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'a.txt'), 'alpha\n', 'utf8')

  bootstrapRuntime({ dataDir })
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const username = 'cow-user'
  const projectId = 'proj-cow'

  getDb()
    .insert(projects)
    .values({
      id: projectId,
      username,
      title: 'COW',
      workspaceRoot: workspace,
      createdAt: now,
      updatedAt: now
    })
    .run()

  const accepted = await createChangeSet(username, { projectId })
  const created = await getChangeSet(username, accepted.changeSetId)
  assert.equal(created.status, 'editing')
  assert.ok(created.baseCommit)
  assert.ok(created.worktreePath)
  assert.equal(existsSync(join(created.worktreePath!, 'a.txt')), true)

  writeFileSync(join(created.worktreePath!, 'a.txt'), 'beta\n', 'utf8')
  writeFileSync(join(created.worktreePath!, 'b.txt'), 'new\n', 'utf8')

  const ready = await markChangeSetReady(username, accepted.changeSetId, created.stateRevision)
  assert.equal(ready.status, 'ready_to_apply')

  const applied = await applyChangeSet(username, accepted.changeSetId, ready.stateRevision)
  assert.equal(applied.status, 'applied')
  assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'beta\n')
  assert.equal(readFileSync(join(workspace, 'b.txt'), 'utf8').replace(/\r\n/g, '\n'), 'new\n')
})

test('rebase re-applies patch onto new git HEAD', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-cs-rebase-'))
  const workspace = join(dataDir, 'ws')
  initGitRepo(workspace)

  bootstrapRuntime({ dataDir })
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const username = 'rebase-user'
  const projectId = 'proj-rebase'

  getDb()
    .insert(projects)
    .values({
      id: projectId,
      username,
      title: 'Rebase',
      workspaceRoot: workspace,
      createdAt: now,
      updatedAt: now
    })
    .run()

  const accepted = await createChangeSet(username, { projectId })
  const created = await getChangeSet(username, accepted.changeSetId)
  writeFileSync(join(created.worktreePath!, 'extra.txt'), 'from-cs\n', 'utf8')
  const ready = await markChangeSetReady(username, accepted.changeSetId, created.stateRevision)
  assert.equal(ready.status, 'ready_to_apply')

  // Diverge main so apply would need resolution; then rebase.
  writeFileSync(join(workspace, 'main.txt'), 'main\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: workspace, windowsHide: true })
  execFileSync('git', ['commit', '-m', 'diverge'], { cwd: workspace, windowsHide: true })

  const blocked = await applyChangeSet(username, accepted.changeSetId, ready.stateRevision)
  assert.equal(blocked.status, 'needs_resolution')

  const rebased = await rebaseChangeSet(username, accepted.changeSetId, blocked.stateRevision)
  assert.ok(rebased.status === 'editing' || rebased.status === 'needs_resolution')
  assert.ok(rebased.worktreePath)
  assert.ok(rebased.baseCommit)
  assert.notEqual(rebased.baseCommit, created.baseCommit)

  if (rebased.status === 'editing') {
    const ready2 = await markChangeSetReady(username, accepted.changeSetId, rebased.stateRevision)
    const applied = await applyChangeSet(username, accepted.changeSetId, ready2.stateRevision)
    assert.equal(applied.status, 'applied')
    assert.equal(existsSync(join(workspace, 'extra.txt')), true)
  }
})

test('non-git rebase preserves unready worktree edits', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-cs-cow-rebase-'))
  const workspace = join(dataDir, 'ws')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'a.txt'), 'base\n', 'utf8')
  writeFileSync(join(workspace, 'other.txt'), 'one\n', 'utf8')

  bootstrapRuntime({ dataDir })
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const username = 'cow-rebase-user'
  const projectId = 'proj-cow-rebase'
  getDb()
    .insert(projects)
    .values({
      id: projectId,
      username,
      title: 'COW rebase',
      workspaceRoot: workspace,
      createdAt: now,
      updatedAt: now
    })
    .run()

  const accepted = await createChangeSet(username, { projectId })
  const created = await getChangeSet(username, accepted.changeSetId)
  writeFileSync(join(created.worktreePath!, 'a.txt'), 'user-edit\n', 'utf8')
  writeFileSync(join(workspace, 'other.txt'), 'two\n', 'utf8')

  const rebased = await rebaseChangeSet(username, accepted.changeSetId, created.stateRevision)
  assert.equal(rebased.status, 'editing')
  assert.equal(readFileSync(join(rebased.worktreePath!, 'a.txt'), 'utf8'), 'user-edit\n')
  assert.equal(readFileSync(join(rebased.worktreePath!, 'other.txt'), 'utf8'), 'two\n')
})

test('pruneTerminalChangeSetTrees removes cancelled worktree dirs', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-cs-prune-'))
  const workspace = join(dataDir, 'ws')
  initGitRepo(workspace)

  bootstrapRuntime({ dataDir })
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const username = 'prune-user'
  const projectId = 'proj-prune'

  getDb()
    .insert(projects)
    .values({
      id: projectId,
      username,
      title: 'Prune',
      workspaceRoot: workspace,
      createdAt: now,
      updatedAt: now
    })
    .run()

  const accepted = await createChangeSet(username, { projectId })
  const wt = changeSetWorktreePath(dataDir, accepted.changeSetId)
  assert.equal(existsSync(wt), true)

  await cancelChangeSet(username, accepted.changeSetId)
  // cancel already removes worktree; create an orphan dir to prune
  mkdirSync(join(dataDir, 'runtimes', 'changes', 'cs-orphan'), { recursive: true })
  writeFileSync(join(dataDir, 'runtimes', 'changes', 'cs-orphan', 'x'), '1', 'utf8')

  const result = await pruneTerminalChangeSetTrees(dataDir)
  assert.ok(result.removed >= 1)
  assert.equal(existsSync(join(dataDir, 'runtimes', 'changes', 'cs-orphan')), false)
})
