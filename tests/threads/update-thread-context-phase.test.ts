import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import { projects, threads, threadJobs } from '../../src/server/db/schema'
import { insertMessage } from '../../src/server/conversation/messages'
import { updateThreadContext } from '../../src/server/threads/service'
import {
  WIZARD_PHASE_COLLECT,
  WIZARD_PHASE_DRAFT_REVIEW,
  WIZARD_PHASE_PLAN_EDIT
} from '../../src/server/wizard/types'

const TEST_USERNAME = 'test-user'
const PROJECT_ID = 'proj-test'

function seedTime(): number {
  return Math.floor(Date.now() / 1000)
}

describe('updateThreadContext wizard phase', () => {
  let dataDir: string

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'codetask-uthreadctx-'))
    await resetAppContextForTests()
    bootstrapRuntime({ dataDir })

    const db = getDb()
    const now = seedTime()
    await db.insert(projects).values({
      id: PROJECT_ID,
      username: TEST_USERNAME,
      title: 'Test Project',
      workspaceRoot: join(dataDir, 'workspace'),
      createdAt: now,
      updatedAt: now
    })
  })

  after(async () => {
    await resetAppContextForTests()
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        /* best-effort */
      }
    }
  })

  async function createTestThread(
    threadId: string,
    wizardPhase: string = WIZARD_PHASE_COLLECT
  ): Promise<void> {
    const db = getDb()
    const now = seedTime()
    await db.insert(threads).values({
      id: threadId,
      username: TEST_USERNAME,
      projectId: PROJECT_ID,
      title: 'Test Thread',
      status: 'draft',
      conversationId: `conv-${threadId}`,
      coreCode: 'codex',
      runtimeStatus: 'idle',
      coreRuntimeJson: '{}',
      wizardPhase,
      threadKind: 'create_task',
      createdAt: now,
      updatedAt: now
    })
  }

  it('keeps wizardPhase as collect when activeDraftId points to collecting placeholder', async () => {
    const threadId = 'thread-collect-1'
    const messageId = 'msg-collect-placeholder-1'

    await createTestThread(threadId)

    await insertMessage({
      id: messageId,
      threadId,
      username: TEST_USERNAME,
      role: 'assistant',
      kind: 'task-launch-draft',
      content: 'Collecting draft',
      coreCode: 'codex',
      conversationId: `conv-${threadId}`,
      payload: { collecting: true }
    })

    const result = await updateThreadContext(TEST_USERNAME, threadId, {
      activeDraftId: messageId
    })

    const db = getDb()
    const row = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1)

    assert.equal(result.wizardPhase, WIZARD_PHASE_COLLECT)
    assert.equal(row[0]?.wizardPhase, WIZARD_PHASE_COLLECT)
  })

  it('advances wizardPhase to draft_review for mature draft with summary', async () => {
    const threadId = 'thread-mature-1'
    const messageId = 'msg-mature-draft-1'

    await createTestThread(threadId)

    await insertMessage({
      id: messageId,
      threadId,
      username: TEST_USERNAME,
      role: 'assistant',
      kind: 'task-launch-draft',
      content: 'Mature draft',
      coreCode: 'codex',
      conversationId: `conv-${threadId}`,
      payload: {
        summary: 'A real task description',
        requirementsContract: { markdown: '# CONTRACT', status: 'pending' }
      }
    })

    const result = await updateThreadContext(TEST_USERNAME, threadId, {
      activeDraftId: messageId
    })

    const db = getDb()
    const row = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1)

    assert.equal(result.wizardPhase, WIZARD_PHASE_DRAFT_REVIEW)
    assert.equal(row[0]?.wizardPhase, WIZARD_PHASE_DRAFT_REVIEW)
  })

  it('advances wizardPhase to plan_edit when activePlanId is set', async () => {
    const threadId = 'thread-plan-1'
    const draftId = 'msg-draft-for-plan-1'
    const planId = 'job-plan-1'

    await createTestThread(threadId, WIZARD_PHASE_DRAFT_REVIEW)

    await insertMessage({
      id: draftId,
      threadId,
      username: TEST_USERNAME,
      role: 'assistant',
      kind: 'task-launch-draft',
      content: 'Confirmed draft',
      coreCode: 'codex',
      conversationId: `conv-${threadId}`,
      payload: {
        summary: 'Confirmed task',
        requirementsContract: { markdown: '# CONTRACT', status: 'confirmed' },
        status: 'confirmed'
      }
    })

    const db = getDb()
    const now = seedTime()
    await db.insert(threadJobs).values({
      id: planId,
      threadId,
      username: TEST_USERNAME,
      draftMessageId: draftId,
      title: 'Test Job',
      summary: 'Test summary',
      status: 'plan_editing',
      workspacePath: join(dataDir, 'workspace'),
      createdAt: now,
      updatedAt: now
    })

    const result = await updateThreadContext(TEST_USERNAME, threadId, {
      activeDraftId: draftId,
      activePlanId: planId
    })

    const row = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1)

    assert.equal(result.wizardPhase, WIZARD_PHASE_PLAN_EDIT)
    assert.equal(row[0]?.wizardPhase, WIZARD_PHASE_PLAN_EDIT)
    assert.equal(row[0]?.activeDraftId, draftId)
    assert.equal(row[0]?.activePlanId, planId)
  })
})
