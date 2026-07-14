import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  acquireWorkspaceLease,
  releaseWorkspaceLeaseForOwner,
  resetWorkspaceLeaseStateForTests
} from '../../src/server/legacy-control-plane/workspace-lease-store'
import {
  THREAD_KIND_CHAT,
  THREAD_KIND_CREATE_TASK,
  WorkflowHarness
} from '../helpers/workflow-harness'

describe('conversation turn preflight', () => {
  const harness = new WorkflowHarness()

  before(async () => {
    await harness.setup()
    resetWorkspaceLeaseStateForTests()
  })

  after(async () => {
    await harness.teardown()
  })

  it('returns HTTP 409 conversation.mode_mismatch for chat thread + generateDraft', async () => {
    const chat = await harness.createThread(THREAD_KIND_CHAT, 'codex')
    const err = await harness.postMessageExpectHttpError(chat.id, 'draft please', {
      generateDraft: true
    })
    assert.equal(err.httpStatus, 409)
    assert.equal(err.code, 'conversation.mode_mismatch')
    assert.equal((await harness.listMessages(chat.id)).length, 0)
  })

  it('returns HTTP 409 conversation.mode_mismatch for chat thread + createTaskMode', async () => {
    const chat = await harness.createThread(THREAD_KIND_CHAT, 'codex')
    const err = await harness.postMessageExpectHttpError(chat.id, 'create task', {
      createTaskMode: true
    })
    assert.equal(err.httpStatus, 409)
    assert.equal(err.code, 'conversation.mode_mismatch')
    assert.equal((await harness.listMessages(chat.id)).length, 0)
  })

  it('returns HTTP 409 conversation.mode_mismatch when create_task thread is sent as chat', async () => {
    const task = await harness.createThread(THREAD_KIND_CREATE_TASK, 'codex')
    const err = await harness.postMessageExpectHttpError(task.id, 'plain chat')
    assert.equal(err.httpStatus, 409)
    assert.equal(err.code, 'conversation.mode_mismatch')
    assert.equal((await harness.listMessages(task.id)).length, 0)
  })

  it('returns HTTP 409 workspace.busy without inserting a user message', async () => {
    const chat = await harness.createThread(THREAD_KIND_CHAT, 'codex')
    const held = acquireWorkspaceLease({
      workspacePath: harness.workspaceRoot,
      ownerKind: 'thread_job',
      ownerId: 'blocking-job'
    })
    assert.ok(held)

    try {
      const err = await harness.postMessageExpectHttpError(chat.id, 'hello while busy')
      assert.equal(err.httpStatus, 409)
      assert.equal(err.code, 'workspace.busy')
      assert.equal((await harness.listMessages(chat.id)).length, 0)
    } finally {
      releaseWorkspaceLeaseForOwner('thread_job', 'blocking-job')
    }
  })
})
