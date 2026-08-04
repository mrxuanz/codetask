/**
 * Conversation turn preflight after architecture 03 — Conversations API only.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  acquireWorkspaceLease,
  getActiveWorkspaceLeaseForOwner,
  releaseWorkspaceLeaseForOwner,
  resetWorkspaceLeaseStateForTests
} from '../../src/server/infra/workspace-lease-store'
import { THREAD_KIND_CHAT, WorkflowHarness } from '../helpers/workflow-harness'

describe('conversation turn preflight (03)', () => {
  const harness = new WorkflowHarness({ inMemory: true })

  before(async () => {
    await harness.setup()
    resetWorkspaceLeaseStateForTests()
  })

  after(async () => {
    await harness.teardown()
  })

  it('rejects generateDraft on conversation turns with 400', async () => {
    const chat = await harness.createThread(THREAD_KIND_CHAT, 'codex')
    const err = await harness.postMessageExpectHttpError(chat.id, 'draft please', {
      generateDraft: true
    })
    assert.equal(err.httpStatus, 400)
    assert.ok(err.code === 'conversation.validation' || err.message?.includes('Draft'))
  })

  it('rejects createTaskMode on conversation turns with 400', async () => {
    const chat = await harness.createThread(THREAD_KIND_CHAT, 'codex')
    const err = await harness.postMessageExpectHttpError(chat.id, 'create task', {
      createTaskMode: true
    })
    assert.equal(err.httpStatus, 400)
  })

  it('workspace exclusive lease can be held by execution without blocking conversation create', async () => {
    const chat = await harness.createThread(THREAD_KIND_CHAT, 'codex')
    const held = acquireWorkspaceLease({
      workspacePath: harness.workspaceRoot,
      ownerKind: 'thread_job',
      ownerId: 'blocking-job'
    })
    assert.ok(held)
    try {
      const active = getActiveWorkspaceLeaseForOwner('thread_job', 'blocking-job')
      assert.ok(active)
      const listed = await harness.getThread(chat.id)
      assert.equal(listed.id, chat.id)
    } finally {
      releaseWorkspaceLeaseForOwner('thread_job', 'blocking-job')
    }
  })
})
