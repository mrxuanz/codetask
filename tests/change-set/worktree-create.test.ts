import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import { projects } from '../../src/server/db/schema'
import {
  cancelChangeSet,
  createChangeSet,
  getChangeSet,
  listProjectChangeSets
} from '../../src/server/change-set/service'
import {
  changeSetWorktreePath,
  isGitWorkspace,
  prepareChangeSetWorktree,
  removeChangeSetWorktree
} from '../../src/server/change-set/worktree'

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

test('prepareChangeSetWorktree creates detached git worktree under data dir', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-cs-wt-'))
  const workspace = join(dataDir, 'project')
  initGitRepo(workspace)

  assert.equal(isGitWorkspace(workspace), true)
  const prepared = prepareChangeSetWorktree({
    dataDir,
    changeSetId: 'cs-test-1',
    workspaceRoot: workspace
  })

  assert.equal(prepared.kind, 'git')
  assert.ok(prepared.baseCommit)
  assert.equal(prepared.worktreePath, changeSetWorktreePath(dataDir, 'cs-test-1'))
  assert.equal(existsSync(join(prepared.worktreePath, 'README.md')), true)

  removeChangeSetWorktree(dataDir, 'cs-test-1', workspace)
  assert.equal(existsSync(prepared.worktreePath), false)
  rmSync(dataDir, { recursive: true, force: true })
})

test('createChangeSet / cancelChangeSet round-trip', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-cs-svc-'))
  const workspace = join(dataDir, 'ws')
  initGitRepo(workspace)

  bootstrapRuntime({ dataDir })
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const username = 'cs-user'
  const projectId = 'proj-cs-1'

  getDb()
    .insert(projects)
    .values({
      id: projectId,
      username,
      title: 'CS Project',
      workspaceRoot: workspace,
      createdAt: now,
      updatedAt: now
    })
    .run()

  const accepted = await createChangeSet(username, { projectId })
  assert.equal(accepted.status, 'editing')
  assert.ok(accepted.changeSetId.startsWith('cs-'))

  const dto = await getChangeSet(username, accepted.changeSetId)
  assert.equal(dto.status, 'editing')
  assert.ok(dto.worktreePath)
  assert.ok(dto.baseCommit)
  assert.equal(existsSync(join(dto.worktreePath!, 'README.md')), true)

  const listed = await listProjectChangeSets(username, projectId)
  assert.equal(listed.length, 1)

  const cancelled = await cancelChangeSet(username, accepted.changeSetId, dto.stateRevision)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.worktreePath, null)
  assert.equal(existsSync(changeSetWorktreePath(dataDir, accepted.changeSetId)), false)
})
