import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { McpHttpClient } from '../helpers/mcp-client'
import { buildProposeTaskDraftArgs } from '../helpers/fixtures'
import { THREAD_KIND_CREATE_TASK, WorkflowHarness } from '../helpers/workflow-harness'

describe('08 permissions and locking workflow', () => {
  const harness = new WorkflowHarness()

  before(async () => {
    await harness.setup()
  })

  after(async () => {
    await harness.teardown()
  })

  it('rejects wizard tool misuse and cross-session MCP calls', async () => {
    harness.installDefaultCollectToPlanScripts()
    const task = await harness.createThread(THREAD_KIND_CREATE_TASK, 'codex')
    await harness.sendMessage(task.id, 'collect 1', { createTaskMode: true })
    await harness.sendMessage(task.id, 'collect 2', {
      createTaskMode: true
    })

    const messages = await harness.listMessages(task.id)
    const draft = harness.findDraftMessage(messages)
    harness.setDraftMessageId(String(draft?.id))

    await harness.sendMessage(task.id, 'review 1', { createTaskMode: true })
    await harness.sendMessage(task.id, 'review 2', { createTaskMode: true })
    await harness.sendMessage(task.id, 'review 3', { createTaskMode: true })
    await harness.sendMessage(task.id, 'review 4', { createTaskMode: true })

    const lockedErr = await harness.jsonExpectError(
      'PATCH',
      `/api/threads/${task.id}/messages/${draft?.id}/draft`,
      { summary: 'mutate locked draft' }
    )
    assert.ok(lockedErr.message.length > 0)

    const collectMcpUrl = `${harness.baseUrl}/api/mcp/conversation/collect-session?role=conversation&wizardStage=collect&threadId=${task.id}&cap=invalid`
    const collectClient = new McpHttpClient(collectMcpUrl)
    await assert.rejects(async () => {
      await collectClient.initialize()
      await collectClient.callTool('register_plan_outline', buildProposeTaskDraftArgs())
    }, /capability|403|failed/i)

    const { job } = await harness.confirmDraftFinal(task.id, String(draft?.id))
    const jobId = String(job.id)
    await harness.waitForJob(jobId, (j) => j.status === 'plan_editing', 60_000)

    const planErr = await harness.jsonExpectError(
      'PATCH',
      `/api/threads/${task.id}/jobs/${jobId}/plan`,
      { nodeRef: 'm1-s1', title: 'mutate confirmed node' }
    )
    assert.ok(planErr.message.length > 0)
  })
})
