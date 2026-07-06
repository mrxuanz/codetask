import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import {
  FIXTURE_MILESTONE_VERDICT_PASSED,
  FIXTURE_SLICE_VERDICT_INCONCLUSIVE,
  FIXTURE_SLICE_VERDICT_NEEDS_REPAIR,
  FIXTURE_SLICE_VERDICT_PASSED,
  FIXTURE_TASK_EVIDENCE
} from '../helpers/fixtures'
import { readJobLastErrorCode, readTaskProgressCode } from '../helpers/turn-error'
import { WorkflowHarness } from '../helpers/workflow-harness'

describe('04 repair and inconclusive workflow', () => {
  const harness = new WorkflowHarness()

  before(async () => {
    await harness.setup()
  })

  beforeEach(async () => {
    harness.resetScripts()
    await harness.drainActiveJobs()
    harness.installDefaultCollectToPlanScripts()
  })

  after(async () => {
    await harness.teardown()
  })

  it('injects repair task after needs-repair verdict', async () => {
    harness.installDefaultExecutionScripts()
    harness.setVerifierOutcome('m1-s1', 0, FIXTURE_SLICE_VERDICT_PASSED)
    harness.setVerifierOutcome('m1-s2', 0, FIXTURE_SLICE_VERDICT_NEEDS_REPAIR)
    harness.setVerifierOutcome('m1-s2', 1, FIXTURE_SLICE_VERDICT_PASSED)
    harness.setMilestoneVerifierOutcome('m1', 0, FIXTURE_MILESTONE_VERDICT_PASSED)

    const seeded = await harness.seedPlanReady()
    const { job: launched } = await harness.confirmPlan(seeded.threadId, seeded.jobId)
    const jobId = String(launched.id)

    const job = await harness.waitForJob(jobId, (j) => j.status === 'completed', 120_000)

    const progress = job.taskProgress as {
      repairGenerations?: Record<string, number>
      tasks?: Array<{ id: string; title?: string }>
    }
    assert.equal(progress.repairGenerations?.['slice:m1-s2'], 1)
    const repairTask = progress.tasks?.find((task) => task.title?.startsWith('[REPAIR]'))
    assert.ok(repairTask)
    assert.match(repairTask?.id ?? '', /m1-s2/)
  })

  it('handles inconclusive evidence loop and stops on unchanged hash', async () => {
    harness.installDefaultExecutionScripts()
    harness.setVerifierOutcome('m1-s1', 0, FIXTURE_SLICE_VERDICT_PASSED)
    harness.setVerifierOutcome('m1-s2', 0, FIXTURE_SLICE_VERDICT_INCONCLUSIVE)
    harness.setVerifierOutcome('m1-s2', 1, FIXTURE_SLICE_VERDICT_INCONCLUSIVE)
    harness.setVerifierOutcome('m1-s2', 2, FIXTURE_SLICE_VERDICT_INCONCLUSIVE)

    const evidenceTaskScript = {
      reply: 'evidence resubmit',
      mcpCalls: [
        {
          tool: 'report_task_result',
          args: { ...FIXTURE_TASK_EVIDENCE, summary: 'evidence resubmit' }
        }
      ]
    }
    harness.registry.setDefaultTaskWorkerScript(evidenceTaskScript)
    const seeded = await harness.seedPlanReady()
    const { job: launched } = await harness.confirmPlan(seeded.threadId, seeded.jobId)
    const jobId = String(launched.id)

    let job = await harness.getJob(jobId)
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      job = await harness.getJob(jobId)
      if (job.status === 'failed' || job.status === 'completed') break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    assert.equal(job.status, 'failed')
    const progressCode = readTaskProgressCode(job)
    if (progressCode) {
      assert.ok(
        progressCode === 'execution.slice_inconclusive_exhausted' ||
          progressCode === 'execution.slice_blocked',
        `unexpected slice verification progress code: ${progressCode}`
      )
    }
    assert.equal(readJobLastErrorCode(job), 'task.terminal_failure')
    const progress = job.taskProgress as { verificationAttempts?: Record<string, number> }
    const attempts = progress.verificationAttempts?.['verification:slice:m1-s2'] ?? 0
    assert.ok(attempts >= 2)
    assert.ok(attempts <= 3)
  })
})
