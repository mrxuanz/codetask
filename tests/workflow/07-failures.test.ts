import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { SandboxError } from '../../src/server/sandbox/types'
import { FIXTURE_SLICE_VERDICT_PASSED, FIXTURE_TASK_EVIDENCE } from '../helpers/fixtures'
import { readJobLastErrorCode } from '../helpers/turn-error'
import { WorkflowHarness } from '../helpers/workflow-harness'

describe('07 failures workflow', () => {
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
    harness.installDefaultCollectToPlanScripts()
  })

  it('fails when provider cannot start', async () => {
    const draft = await harness.seedDraftReady()
    harness.setScript('planner:0', {
      reply: 'fail',
      failStart: new Error('provider bootstrap failed')
    })
    const { job } = await harness.confirmDraftFinal(draft.threadId, draft.draftMessageId)
    const jobId = String(job.id)
    await harness.waitForJob(jobId, (j) => j.status === 'failed', 30_000)
    const failedJob = await harness.getJob(jobId)
    assert.equal(readJobLastErrorCode(failedJob), 'turn.unknown')
    assert.equal(failedJob.status, 'failed')
  })

  it('fails on invalid MCP evidence payload', async () => {
    harness.setScript('task-worker:m1-s1-t1', {
      reply: 'bad evidence',
      mcpCalls: [
        {
          tool: 'report_task_result',
          args: {
            status: 'completed',
            summary: 'done',
            validation: { ran: true, outcome: 'passed' }
          }
        }
      ]
    })
    for (const taskId of ['m1-s2-t1', 'm1-s2-t2']) {
      harness.setScript(`task-worker:${taskId}`, {
        reply: 'done',
        mcpCalls: [{ tool: 'report_task_result', args: { ...FIXTURE_TASK_EVIDENCE } }]
      })
    }
    harness.setVerifierOutcome('m1-s1', 0, FIXTURE_SLICE_VERDICT_PASSED)
    harness.setVerifierOutcome('m1-s2', 0, FIXTURE_SLICE_VERDICT_PASSED)

    const seeded = await harness.seedPlanReady()
    const { job: launched } = await harness.confirmPlan(seeded.threadId, seeded.jobId)
    const job = await harness.waitForJob(String(launched.id), (j) => j.status === 'failed', 120_000)
    const errorCode = readJobLastErrorCode(job)
    assert.ok(
      errorCode === 'task.terminal_failure' || errorCode === 'turn.unknown',
      `expected terminal failure, got ${errorCode ?? 'null'}`
    )
  })

  it('fails when task worker completes without report_task_result', async () => {
    harness.setScript('task-worker:m1-s1-t1', { reply: 'no report', mcpCalls: [] })
    const seeded = await harness.seedPlanReady()
    const { job: launched } = await harness.confirmPlan(seeded.threadId, seeded.jobId)
    const job = await harness.waitForJob(String(launched.id), (j) => j.status === 'failed', 120_000)
    const errorCode = readJobLastErrorCode(job)
    assert.ok(
      errorCode === 'task.evidence_timeout' || errorCode === 'task.infra_retry_exhausted',
      `expected evidence failure, got ${errorCode ?? 'null'}`
    )
  })

  it('fails when planner does not finalize_plan', async () => {
    const draft = await harness.seedDraftReady()
    harness.setScript('planner:0', { reply: 'no plan', mcpCalls: [] })
    const { job } = await harness.confirmDraftFinal(draft.threadId, draft.draftMessageId)
    const jobId = String(job.id)
    const failed = await harness.waitForJob(jobId, (j) => j.status === 'failed', 30_000)
    assert.equal(readJobLastErrorCode(failed), 'draft.plan_not_ready')
    assert.equal(failed.status, 'failed')
  })

  it('maps sandbox crash to explicit job failure', async () => {
    harness.setScript('task-worker:m1-s1-t1', {
      reply: 'sandbox crash',
      failStart: new SandboxError('sandbox worker crashed', 'sandbox.crashed')
    })
    const seeded = await harness.seedPlanReady()
    const { job: launched } = await harness.confirmPlan(seeded.threadId, seeded.jobId)
    const job = await harness.waitForJob(String(launched.id), (j) => j.status === 'failed', 60_000)
    assert.equal(readJobLastErrorCode(job), 'turn.unknown')
    assert.equal(job.status, 'failed')
  })
})
