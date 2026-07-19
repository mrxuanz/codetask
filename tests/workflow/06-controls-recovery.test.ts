import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import {
  FIXTURE_MILESTONE_VERDICT_PASSED,
  FIXTURE_SLICE_VERDICT_PASSED,
  FIXTURE_TASK_EVIDENCE
} from '../helpers/fixtures'
import { WorkflowHarness } from '../helpers/workflow-harness'

function installPassingExecutionScripts(harness: WorkflowHarness): void {
  const workerScript = {
    reply: 'task done',
    mcpCalls: [{ tool: 'report_task_result', args: { ...FIXTURE_TASK_EVIDENCE } }]
  }
  harness.registry.setDefaultTaskWorkerScript(workerScript)
  for (const taskId of ['m1-s1-t1', 'm1-s2-t1', 'm1-s2-t2']) {
    harness.setScript(`task-worker:${taskId}`, workerScript)
  }
  harness.setVerifierOutcome('m1-s1', 0, FIXTURE_SLICE_VERDICT_PASSED)
  harness.setVerifierOutcome('m1-s2', 0, FIXTURE_SLICE_VERDICT_PASSED)
  harness.setMilestoneVerifierOutcome('m1', 0, FIXTURE_MILESTONE_VERDICT_PASSED)
}

describe('06 controls and recovery workflow', () => {
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

  it('cancels planning when planner hangs', async () => {
    harness.setScript('planner:0', { reply: 'planning...', hang: true })

    const started = await harness.startPlanningJob()
    await harness.waitForJob(started.jobId, (job) => job.status === 'planning', 30_000)
    const cancelled = await harness.cancelJob(started.jobId)
    assert.equal(cancelled.status, 'cancelled')
  })

  it('pauses and resumes a running task', async () => {
    installPassingExecutionScripts(harness)
    harness.setScript('task-worker:m1-s1-t1', { reply: 'running', hang: true })

    const seeded = await harness.seedPlanReady()
    const { job: launched } = await harness.confirmPlan(seeded.threadId, seeded.jobId)
    const jobId = String(launched.id)

    await harness.waitForJob(
      jobId,
      (job) => {
        const progress = job.taskProgress as {
          currentTaskId?: string
          message?: string
          tasks?: Array<{ id: string; status?: string }>
        }
        if (progress.currentTaskId === 'm1-s1-t1') return true
        if (String(progress.message ?? '').includes('m1-s1-t1')) return true
        return (
          progress.tasks?.some((task) => task.id === 'm1-s1-t1' && task.status === 'running') ===
          true
        )
      },
      60_000
    )

    await harness.pauseJob(jobId)
    const paused = await harness.waitForJob(jobId, (job) => job.status === 'paused', 30_000)
    assert.equal(paused.status, 'paused')

    harness.setScript('task-worker:m1-s1-t1', {
      reply: 'done',
      mcpCalls: [{ tool: 'report_task_result', args: { ...FIXTURE_TASK_EVIDENCE } }]
    })
    await harness.resumeJob(jobId)
    const completed = await harness.waitForJob(jobId, (job) => job.status === 'completed', 120_000)
    assert.equal(completed.status, 'completed')
  })

  it('recovers progress fields after service restart', async () => {
    installPassingExecutionScripts(harness)
    harness.setVerifierOutcome('m1-s2', 0, {
      status: 'needs-repair',
      confidence: 'medium',
      summary: 'repair needed',
      satisfiedSignals: [],
      missingSignals: [],
      questionableClaims: [],
      evidenceTrace: [],
      repairSuggestions: [
        {
          reason: 'gap',
          instruction: 'fix',
          targetTaskId: 'm1-s2-t1'
        }
      ]
    })
    harness.setVerifierOutcome('m1-s2', 1, FIXTURE_SLICE_VERDICT_PASSED)
    harness.setMilestoneVerifierOutcome('m1', 0, FIXTURE_MILESTONE_VERDICT_PASSED)

    const seeded = await harness.seedPlanReady()
    const { job: launched } = await harness.confirmPlan(seeded.threadId, seeded.jobId)
    const jobId = String(launched.id)

    let job = await harness.waitForJob(
      jobId,
      (j) => {
        const progress = j.taskProgress as { repairGenerations?: Record<string, number> }
        return (progress.repairGenerations?.['slice:m1-s2'] ?? 0) >= 1
      },
      120_000
    )

    // Do not pause-and-wait-for-idle: pause can leave the loop active for >60s on CI.
    // Assert recovery preserves already-observed progress; abort/drain may add
    // incidental verifier-infra keys, so require before ⊆ after rather than deepEqual.
    job = await harness.getJob(jobId)
    const messagesBefore = await harness.listMessages(seeded.threadId)
    const threadBefore = await harness.getThread(seeded.threadId)
    const progressBefore = job.taskProgress as {
      repairGenerations?: Record<string, number>
      verificationAttempts?: Record<string, number>
      verificationBundleHashes?: Record<string, string>
    }

    await harness.simulateServiceRestart()
    job = await harness.getJob(jobId)
    const threadAfter = await harness.getThread(seeded.threadId)
    const messagesAfter = await harness.listMessages(seeded.threadId)

    assert.equal(messagesAfter.length, messagesBefore.length)
    assert.equal(threadAfter.activeDraftId, threadBefore.activeDraftId)
    assert.equal(threadAfter.activePlanId, threadBefore.activePlanId)
    const progressAfter = job.taskProgress as typeof progressBefore
    for (const [key, value] of Object.entries(progressBefore.repairGenerations ?? {})) {
      assert.equal(
        progressAfter.repairGenerations?.[key],
        value,
        `repairGenerations[${key}] must survive restart`
      )
    }
    for (const [key, value] of Object.entries(progressBefore.verificationAttempts ?? {})) {
      assert.equal(
        progressAfter.verificationAttempts?.[key],
        value,
        `verificationAttempts[${key}] must survive restart`
      )
    }
    for (const [key, value] of Object.entries(progressBefore.verificationBundleHashes ?? {})) {
      assert.equal(
        progressAfter.verificationBundleHashes?.[key],
        value,
        `verificationBundleHashes[${key}] must survive restart`
      )
    }

    if (job.status === 'paused') {
      await harness.resumeJob(jobId)
    } else if (job.status === 'pausing') {
      job = await harness.waitForJob(
        jobId,
        (j) => j.status === 'paused' || j.status === 'completed',
        30_000
      )
      if (job.status === 'paused') await harness.resumeJob(jobId)
    }
    if (job.status !== 'completed') {
      job = await harness.waitForJob(jobId, (j) => j.status === 'completed', 120_000)
    }

    assert.equal(job.status, 'completed')
  })
})
