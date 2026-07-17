import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { parseHubTopic, turnIdFromTopic, turnTopic } from '../../src/shared/contracts/job-event-hub'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import { conversationTurns, projects, threads } from '../../src/server/db/schema'
import {
  cancelConversationTurn,
  enqueueConversationTurn,
  getTurn,
  reconcileConversationTurnsOnStartup
} from '../../src/server/conversation/turn-queue'
import {
  resetCoreAvailabilityStubForTests,
  setCoreAvailabilityStubForTests
} from '../../src/server/conversation/cores'
import {
  resetTestAgentTurnProviders,
  setTestAgentTurnProviders
} from '../../src/server/agent-runtime/providers/test-overrides'

test('parseHubTopic accepts turn topics', () => {
  assert.equal(parseHubTopic('turn:abc'), 'turn:abc')
  assert.equal(parseHubTopic('turn:'), null)
  assert.equal(turnIdFromTopic(turnTopic('t1')), 't1')
})

test('same-thread turns stay queued while another turn is active; cancel clears queue', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-turn-queue-'))
  bootstrapRuntime({ dataDir })
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const username = 'turn-user'
  const projectId = 'proj-turn-1'
  const threadId = 'thread-turn-1'

  getDb()
    .insert(projects)
    .values({
      id: projectId,
      username,
      title: 'Turn Project',
      workspaceRoot: join(dataDir, 'ws'),
      createdAt: now,
      updatedAt: now
    })
    .run()

  getDb()
    .insert(threads)
    .values({
      id: threadId,
      projectId,
      username,
      title: 'Chat',
      status: 'draft',
      conversationId: `conv-${threadId}`,
      coreCode: 'codex',
      threadKind: 'chat',
      runtimeStatus: 'idle',
      coreRuntimeJson: '{}',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    })
    .run()

  getDb()
    .insert(conversationTurns)
    .values({
      id: 'turn-active',
      threadId,
      username,
      kind: 'chat',
      status: 'running',
      workspaceAccess: 'live-read',
      provider: null,
      messageText: 'first',
      generateDraft: 0,
      createTaskMode: 0,
      attachmentIdsJson: '[]',
      selectedDraftSection: null,
      selectedPlanNodeRef: null,
      idempotencyKey: null,
      stateRevision: 1,
      lastErrorJson: null,
      createdAt: now - 10,
      startedAt: now - 10,
      completedAt: null
    })
    .run()

  const accepted = await enqueueConversationTurn({
    username,
    threadId,
    message: 'second message'
  })
  assert.equal(accepted.status, 'queued')
  assert.equal(accepted.queuePosition, 1)

  const queued = await getTurn(username, accepted.turnId)
  assert.ok(queued)
  assert.equal(queued.status, 'queued')

  const cancelled = await cancelConversationTurn(username, accepted.turnId)
  assert.equal(cancelled.status, 'cancelled')

  const again = await enqueueConversationTurn({
    username,
    threadId,
    message: 'idempotent',
    idempotencyKey: 'idem-1'
  })
  const replay = await enqueueConversationTurn({
    username,
    threadId,
    message: 'idempotent',
    idempotencyKey: 'idem-1'
  })
  assert.equal(replay.turnId, again.turnId)

  const reconciled = reconcileConversationTurnsOnStartup()
  assert.equal(reconciled.failed, 1)
  assert.equal((await getTurn(username, 'turn-active'))?.status, 'failed')
})

test('same-second queued turns preserve insertion order', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-turn-order-'))
  bootstrapRuntime({ dataDir })
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const username = 'order-user'
  const projectId = 'proj-order'
  const threadId = 'thread-order'
  getDb()
    .insert(projects)
    .values({
      id: projectId,
      username,
      title: 'Order',
      workspaceRoot: join(dataDir, 'ws'),
      createdAt: now,
      updatedAt: now
    })
    .run()
  getDb()
    .insert(threads)
    .values({
      id: threadId,
      projectId,
      username,
      title: 'Order',
      status: 'draft',
      conversationId: `conv-${threadId}`,
      coreCode: 'codex',
      threadKind: 'chat',
      runtimeStatus: 'idle',
      coreRuntimeJson: '{}',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    })
    .run()
  getDb()
    .insert(conversationTurns)
    .values({
      id: 'turn-blocker',
      threadId,
      username,
      kind: 'chat',
      status: 'running',
      workspaceAccess: 'live-read',
      provider: null,
      messageText: 'blocker',
      generateDraft: 0,
      createTaskMode: 0,
      attachmentIdsJson: '[]',
      selectedDraftSection: null,
      selectedPlanNodeRef: null,
      idempotencyKey: null,
      stateRevision: 1,
      lastErrorJson: null,
      createdAt: now - 1,
      startedAt: now - 1,
      completedAt: null
    })
    .run()

  const first = await enqueueConversationTurn({ username, threadId, message: 'first' })
  const second = await enqueueConversationTurn({ username, threadId, message: 'second' })
  assert.equal(first.queuePosition, 1)
  assert.equal(second.queuePosition, 2)
})

test('provider error events settle the durable turn as failed', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-turn-provider-error-'))
  bootstrapRuntime({ dataDir })
  setCoreAvailabilityStubForTests((code) => ({
    code,
    label: code,
    description: 'test provider',
    available: true,
    detectedCommand: code,
    launchCommand: code,
    executablePath: join(dataDir, 'bin', code)
  }))
  setTestAgentTurnProviders({
    codex: {
      code: 'codex',
      protocol: 'fake',
      async *streamTurn() {
        yield { type: 'error', message: 'provider boom' }
      }
    }
  })
  t.after(async () => {
    resetTestAgentTurnProviders()
    resetCoreAvailabilityStubForTests()
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const username = 'provider-error-user'
  const projectId = 'proj-provider-error'
  const threadId = 'thread-provider-error'
  const workspaceRoot = join(dataDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  getDb()
    .insert(projects)
    .values({
      id: projectId,
      username,
      title: 'Provider Error',
      workspaceRoot,
      createdAt: now,
      updatedAt: now
    })
    .run()
  getDb()
    .insert(threads)
    .values({
      id: threadId,
      projectId,
      username,
      title: 'Provider Error',
      status: 'draft',
      conversationId: `conv-${threadId}`,
      coreCode: 'codex',
      threadKind: 'chat',
      runtimeStatus: 'idle',
      coreRuntimeJson: '{}',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now
    })
    .run()

  const accepted = await enqueueConversationTurn({
    username,
    threadId,
    message: 'fail this turn',
    provider: 'codex'
  })
  let settled = await getTurn(username, accepted.turnId)
  const deadline = Date.now() + 3_000
  while (settled && !['completed', 'failed', 'cancelled'].includes(settled.status)) {
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 20))
    settled = await getTurn(username, accepted.turnId)
  }

  assert.equal(settled?.status, 'failed')
  assert.match(settled?.lastError?.message ?? '', /provider boom/)
})
