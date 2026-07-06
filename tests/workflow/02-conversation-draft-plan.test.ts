import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  THREAD_KIND_CHAT,
  THREAD_KIND_CREATE_TASK,
  WorkflowHarness
} from '../helpers/workflow-harness'

describe('02 conversation draft plan workflow', () => {
  const harness = new WorkflowHarness()

  before(async () => {
    await harness.setup()
  })

  after(async () => {
    await harness.teardown()
  })

  it('keeps multi-turn history across core switches on chat thread', async () => {
    const chat = await harness.createThread(THREAD_KIND_CHAT, 'codex')
    harness.setScript('conversation:general:codex:1', { reply: 'codex turn 1', mcpCalls: [] })
    harness.setScript('conversation:general:codex:2', { reply: 'codex turn 2', mcpCalls: [] })
    await harness.sendMessage(chat.id, '第一轮')
    await harness.sendMessage(chat.id, '第二轮')

    await harness.switchCore(chat.id, 'cursorcli')
    harness.setScript('conversation:general:cursorcli:1', {
      reply: 'cursor turn 3',
      mcpCalls: []
    })
    await harness.sendMessage(chat.id, '第三轮')

    const messages = await harness.listMessages(chat.id)
    assert.equal(messages.length, 6)
    assert.equal(messages.filter((m) => m.role === 'user').length, 3)
    assert.equal(messages.filter((m) => m.role === 'assistant').length, 3)
    assert.equal(messages[5]?.coreCode, 'cursorcli')
  })

  it('runs collect → draft review → planner with revision and locked contract', async () => {
    harness.installDefaultCollectToPlanScripts()
    const task = await harness.createThread(THREAD_KIND_CREATE_TASK, 'codex')

    await harness.sendMessage(task.id, 'collect round 1', { createTaskMode: true })
    await harness.sendMessage(task.id, 'collect round 2', { createTaskMode: true })

    let messages = await harness.listMessages(task.id)
    const draft = harness.findDraftMessage(messages)
    assert.ok(draft?.id)
    harness.setDraftMessageId(String(draft.id))
    const revisionAfterDraft = (draft.payload as { revision?: number })?.revision ?? 1

    await harness.sendMessage(task.id, 'draft review 1', { createTaskMode: true })
    await harness.sendMessage(task.id, 'draft review 2', { createTaskMode: true })
    await harness.sendMessage(task.id, 'draft review 3', { createTaskMode: true })
    await harness.sendMessage(task.id, 'draft review 4', { createTaskMode: true })

    messages = await harness.listMessages(task.id)
    const updatedDraft = harness.findDraftMessage(messages)
    const payload = updatedDraft?.payload as {
      revision?: number
      requirementsContract?: { status?: string }
    }
    assert.ok((payload?.revision ?? 0) > revisionAfterDraft)
    assert.equal(payload?.requirementsContract?.status, 'confirmed')

    const patch = await harness.json<{
      skippedLockedSections?: string[]
      payload?: { requirementsContract?: { markdown?: string } }
    }>('PATCH', `/api/threads/${task.id}/messages/${draft?.id}/draft`, {
      requirementsContractMarkdown: '# mutated',
      revision: payload?.revision
    })
    assert.ok(patch.skippedLockedSections?.includes('requirementsContractMarkdown'))
    assert.notEqual(patch.payload?.requirementsContract?.markdown, '# mutated')

    const { job } = await harness.confirmDraftFinal(task.id, String(draft?.id))
    const jobId = String(job.id)
    const readyJob = await harness.waitForJob(jobId, (j) => j.status === 'plan_editing', 60_000)
    const plan = readyJob.plan as {
      milestones?: unknown[]
      tasks?: Array<{ contextMarkdown?: string }>
    }
    assert.equal(plan.milestones?.length, 1)
    assert.equal(plan.tasks?.length, 3)
    for (const taskItem of plan.tasks ?? []) {
      assert.ok(taskItem.contextMarkdown?.trim())
    }
  })
})
