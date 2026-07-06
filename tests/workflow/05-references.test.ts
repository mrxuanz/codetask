import assert from 'node:assert/strict'
import { readJobLastErrorCode } from '../helpers/turn-error'
import { after, before, beforeEach, describe, it } from 'node:test'
import { buildProposeTaskDraftArgs, buildRegisterPlanArgs } from '../helpers/fixtures'
import { THREAD_KIND_CREATE_TASK, WorkflowHarness } from '../helpers/workflow-harness'

describe('05 references workflow', () => {
  const harness = new WorkflowHarness()

  before(async () => {
    await harness.setup()
  })

  after(async () => {
    await harness.teardown()
  })

  beforeEach(async () => {
    harness.resetScripts()
    await harness.drainActiveJobs()
  })

  it('freezes draft references and assigns them to plan tasks', async () => {
    const task = await harness.createThread(THREAD_KIND_CREATE_TASK, 'codex')
    const refA = await harness.uploadAttachment(task.id, 'ref-a.md', '# Ref A\n')
    const refB = await harness.uploadAttachment(task.id, 'ref-b.md', '# Ref B\n')

    harness.setScript('conversation:collect:codex:1', {
      reply: 'reading ref-a',
      mcpCalls: [{ tool: 'read_reference_attachment', args: { attachmentId: refA.id } }]
    })
    harness.setScript('conversation:collect:codex:2', {
      reply: 'propose draft',
      mcpCalls: [{ tool: 'propose_task_draft', args: buildProposeTaskDraftArgs() }]
    })

    await harness.sendMessage(task.id, '读取附件', {
      createTaskMode: true,
      attachmentIds: [refA.id, refB.id]
    })
    await harness.sendMessage(task.id, '生成草案', {
      createTaskMode: true,
      attachmentIds: [refA.id, refB.id]
    })

    const messages = await harness.listMessages(task.id)
    const draft = harness.findDraftMessage(messages)
    const payload = draft?.payload as {
      references?: Array<{ id: string }>
      lockedSections?: { references?: boolean }
    }
    const refIds = (payload?.references ?? []).map((item) => item.id).sort()
    assert.deepEqual(refIds, [refA.id, refB.id].sort())

    harness.setDraftMessageId(String(draft?.id))
    harness.installDefaultCollectToPlanScripts()
    harness.setScript('conversation:draft_review:codex:1', {
      reply: 'lock refs',
      mcpCalls: [{ tool: 'confirm_draft_section', args: { section: 'references' } }]
    })
    harness.registry.set('planner:0', {
      reply: 'plan with ref-a',
      mcpCalls: [
        ...buildRegisterPlanArgs([refA.id]).milestones.flatMap((m, mi) =>
          m.slices.flatMap((s, si) =>
            s.tasks.map((t, ti) => ({
              tool: 'register_task_context',
              args: {
                milestone: mi + 1,
                slice: si + 1,
                task: ti + 1,
                taskTitle: t.title,
                content: `context for ${t.title}`
              }
            }))
          )
        ),
        { tool: 'register_plan', args: buildRegisterPlanArgs([refA.id]) }
      ]
    })

    await harness.sendMessage(task.id, 'review', { createTaskMode: true })
    const messagesAfterLock = await harness.listMessages(task.id)
    const draftAfterLock = harness.findDraftMessage(messagesAfterLock)
    const lockedPayload = draftAfterLock?.payload as {
      lockedSections?: { references?: boolean }
    }
    assert.equal(lockedPayload?.lockedSections?.references, true)

    await harness.sendMessage(task.id, 'update', { createTaskMode: true })
    await harness.sendMessage(task.id, 'revise', { createTaskMode: true })
    await harness.sendMessage(task.id, 'confirm contract', { createTaskMode: true })

    const { job } = await harness.confirmDraftFinal(task.id, String(draft?.id))
    const jobId = String(job.id)
    const readyJob = await harness.waitForJob(jobId, (j) => j.status === 'plan_editing', 60_000)
    const implTask = (
      readyJob.plan as { tasks?: Array<{ id: string; referenceIds?: string[] }> }
    )?.tasks?.find((item) => item.id === 'm1-s2-t1')
    assert.deepEqual(implTask?.referenceIds, [refA.id])
  })

  it('rejects register_plan with non-frozen reference ids', async () => {
    const task = await harness.createThread(THREAD_KIND_CREATE_TASK, 'codex')
    const refA = await harness.uploadAttachment(task.id, 'ref-a.md', '# Ref A\n')

    harness.setScript('conversation:collect:codex:1', {
      reply: 'collecting',
      mcpCalls: []
    })
    harness.setScript('conversation:collect:codex:2', {
      reply: 'propose draft',
      mcpCalls: [{ tool: 'propose_task_draft', args: buildProposeTaskDraftArgs() }]
    })

    await harness.sendMessage(task.id, '开始', {
      createTaskMode: true,
      attachmentIds: [refA.id]
    })
    await harness.sendMessage(task.id, '生成草案', {
      createTaskMode: true,
      attachmentIds: [refA.id]
    })

    const messages = await harness.listMessages(task.id)
    const draft = harness.findDraftMessage(messages)
    harness.setDraftMessageId(String(draft?.id))

    harness.installDefaultCollectToPlanScripts()
    harness.setScript('conversation:draft_review:codex:1', {
      reply: 'lock refs',
      mcpCalls: [{ tool: 'confirm_draft_section', args: { section: 'references' } }]
    })
    harness.registry.set('planner:0', {
      reply: 'bad ref',
      mcpCalls: [
        ...buildRegisterPlanArgs(['ref-not-frozen']).milestones.flatMap((m, mi) =>
          m.slices.flatMap((s, si) =>
            s.tasks.map((t, ti) => ({
              tool: 'register_task_context',
              args: {
                milestone: mi + 1,
                slice: si + 1,
                task: ti + 1,
                taskTitle: t.title,
                content: `context for ${t.title}`
              }
            }))
          )
        ),
        { tool: 'register_plan', args: buildRegisterPlanArgs(['ref-not-frozen']) }
      ]
    })

    await harness.sendMessage(task.id, 'review', { createTaskMode: true })
    await harness.sendMessage(task.id, 'update', { createTaskMode: true })
    await harness.sendMessage(task.id, 'revise', { createTaskMode: true })
    await harness.sendMessage(task.id, 'confirm contract', { createTaskMode: true })

    const { job } = await harness.confirmDraftFinal(task.id, String(draft?.id))
    const jobId = String(job.id)
    const failed = await harness.waitForJob(jobId, (j) => j.status === 'failed', 60_000)
    assert.equal(readJobLastErrorCode(failed), 'draft.reference_invalid')
  })
})
