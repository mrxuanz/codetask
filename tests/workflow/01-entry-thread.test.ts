import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { buildProposeTaskDraftArgs } from '../helpers/fixtures'
import {
  THREAD_KIND_CHAT,
  THREAD_KIND_CREATE_TASK,
  WorkflowHarness
} from '../helpers/workflow-harness'

describe('01 entry thread workflow', () => {
  const harness = new WorkflowHarness()

  before(async () => {
    await harness.setup()
  })

  after(async () => {
    await harness.teardown()
  })

  it('binds project workspace and rejects cross-mode messaging', async () => {
    const project = await harness.createProject()
    assert.equal(project.workspaceRoot, harness.workspaceRoot)

    const chat = await harness.createThread(THREAD_KIND_CHAT, 'codex')
    harness.setScript('conversation:general:codex:1', { reply: 'hello chat', mcpCalls: [] })
    const chatEvents = await harness.sendMessage(chat.id, '你好')
    assert.ok(chatEvents.some((event) => event.event === 'done'))

    const taskErr = await harness.sendMessageExpectError(chat.id, '创建任务', {
      createTaskMode: true
    })
    assert.equal(taskErr.code, 'thread.kind_mismatch')

    const task = await harness.createThread(THREAD_KIND_CREATE_TASK, 'codex')
    const taskErr2 = await harness.sendMessageExpectError(task.id, '普通聊天')
    assert.equal(taskErr2.code, 'thread.kind_mismatch')
  })

  it('restores activeDraftId and activePlanId after reload', async () => {
    const task = await harness.createThread(THREAD_KIND_CREATE_TASK, 'codex')
    harness.setScript('conversation:collect:codex:1', { reply: 'collecting', mcpCalls: [] })
    harness.setScript('conversation:collect:codex:2', {
      reply: 'draft',
      mcpCalls: [{ tool: 'propose_task_draft', args: buildProposeTaskDraftArgs() }]
    })
    await harness.sendMessage(task.id, '需求说明', { createTaskMode: true })
    await harness.sendMessage(task.id, '生成草案', { createTaskMode: true, generateDraft: true })

    const messages = await harness.listMessages(task.id)
    const draft = harness.findDraftMessage(messages)
    assert.ok(draft?.id)

    const threadAfterDraft = await harness.getThread(task.id)
    assert.equal(threadAfterDraft.activeDraftId, draft?.id)

    harness.installDefaultCollectToPlanScripts()
    harness.setDraftMessageId(String(draft?.id))
    await harness.sendMessage(task.id, 'review', { createTaskMode: true })
    await harness.sendMessage(task.id, 'update', { createTaskMode: true })
    await harness.sendMessage(task.id, 'revise', { createTaskMode: true })
    await harness.sendMessage(task.id, 'confirm contract', { createTaskMode: true })

    const { job } = await harness.confirmDraftFinal(task.id, String(draft?.id))
    const jobId = String(job.id)
    await harness.waitForJob(jobId, (j) => j.status === 'plan_editing', 60_000)

    const threadAfterPlan = await harness.getThread(task.id)
    assert.equal(threadAfterPlan.activePlanId, jobId)

    const latest = await harness.json<{ job: Record<string, unknown> }>(
      'GET',
      `/api/threads/${task.id}/jobs/latest`
    )
    assert.equal(String(latest.job.id), jobId)

    const reloadedProject = await harness.json<{ workspaceRoot: string }>(
      'GET',
      `/api/projects/${harness.projectId}`
    )
    assert.equal(reloadedProject.workspaceRoot, harness.workspaceRoot)
  })
})
