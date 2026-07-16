import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ensureConversationRuntimeRoot,
  ensureJobRuntimeRoot,
  ensureJobTaskRuntimeRoot
} from '../../src/server/agent-runtime/runner'
import { removeInvalidCursorCliConfig } from '../../src/server/agent-runtime/cursor-acp/cursor-workspace'
import {
  getCursorHostStateLockStats,
  resetCursorHostStateLockForTests,
  withCursorHostStateLock
} from '../../src/server/agent-runtime/cursor-acp/cursor-host-state'

test('ensureConversationRuntimeRoot isolates chat vs create_task directories', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-p5-conv-'))
  const threadId = 'thread-1'
  const core = 'cursorcli'

  const chatRoot = ensureConversationRuntimeRoot(dataDir, threadId, 'chat', core)
  const createRoot = ensureConversationRuntimeRoot(dataDir, threadId, 'create_task', core)

  assert.equal(chatRoot, join(dataDir, 'runtimes', threadId, 'chat', core))
  assert.equal(createRoot, join(dataDir, 'runtimes', threadId, 'create_task', core))
  assert.notEqual(chatRoot, createRoot)
  assert.equal(existsSync(join(chatRoot, 'tmp')), true)
  assert.equal(existsSync(join(createRoot, 'tmp')), true)
})

test('ensureJobRuntimeRoot is stable across tasks (not task-scoped)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-p5-job-'))
  const threadId = 'thread-job'
  const jobId = 'job-42'
  const core = 'cursorcli'

  const rootA = ensureJobRuntimeRoot(dataDir, threadId, jobId, core)
  const rootB = ensureJobRuntimeRoot(dataDir, threadId, jobId, core)
  const taskRoot = ensureJobTaskRuntimeRoot(dataDir, threadId, jobId, 'task-a', core)

  assert.equal(rootA, rootB)
  assert.equal(rootA, join(dataDir, 'runtimes', threadId, 'jobs', jobId, core))
  assert.notEqual(rootA, taskRoot)
  assert.match(taskRoot, /tasks[/\\]task-a/)
})

test('removeInvalidCursorCliConfig never deletes project .cursor/cli.json', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'codetask-p5-cli-'))
  const cursorDir = join(workspace, '.cursor')
  mkdirSync(cursorDir, { recursive: true })
  const cliPath = join(cursorDir, 'cli.json')
  writeFileSync(cliPath, '{"version":1}\n', 'utf8')

  const result = removeInvalidCursorCliConfig(workspace)

  assert.equal(result.cliConfigPath, cliPath)
  assert.equal(result.removed, false)
  assert.equal(existsSync(cliPath), true)
  assert.equal(readFileSync(cliPath, 'utf8'), '{"version":1}\n')
})

test('withCursorHostStateLock serializes Cursor host writes only', async () => {
  resetCursorHostStateLockForTests()
  const order: number[] = []

  const slow = withCursorHostStateLock(async () => {
    order.push(1)
    await new Promise((r) => setTimeout(r, 30))
    order.push(2)
    return 'a'
  })

  // Non-Cursor path: plain async work proceeds without waiting on the host lock.
  let nonCursorDone = false
  const nonCursor = (async () => {
    await new Promise((r) => setTimeout(r, 5))
    nonCursorDone = true
    return 'plain'
  })()

  const second = withCursorHostStateLock(() => {
    order.push(3)
    return 'b'
  })

  const [a, plain, b] = await Promise.all([slow, nonCursor, second])

  assert.equal(a, 'a')
  assert.equal(plain, 'plain')
  assert.equal(b, 'b')
  assert.equal(nonCursorDone, true)
  assert.deepEqual(order, [1, 2, 3])

  const stats = getCursorHostStateLockStats()
  assert.equal(stats.acquireCount, 2)
  assert.ok(stats.waitMsTotal >= 0)
})
