import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FileSystemDraftAssetStore } from '../../../src/server/adapters/fs'
import { openKernelDatabase, SqliteUnitOfWork } from '../../../src/server/adapters/sqlite'
import { ConversationService } from '../../../src/server/core/application/conversation'
import { DraftService } from '../../../src/server/core/application/draft'
import { JobService } from '../../../src/server/core/application/job'
import { createJobModule, type JobItemExecutor } from '../../../src/server/composition/job'
import type { ExecutionTree } from '../../../src/server/core/domain/draft'
import type {
  JobSettings,
  VerificationResult,
  WorkResult
} from '../../../src/server/core/domain/job'

const USER_ID = 'user-1'
const WORK_COMPLETED: WorkResult = {
  status: 'completed',
  summary: 'Work completed.',
  changedFiles: ['src/result.ts'],
  evidence: ['focused test passed']
}
const VERIFIED: VerificationResult = {
  status: 'passed',
  summary: 'Gate passed.',
  evidence: ['expected behavior observed'],
  repairTasks: []
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('test.wait_timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function tree(taskCount = 2): ExecutionTree {
  return {
    schemaVersion: 1,
    title: 'Ordered Job',
    summary: 'Exercise durable ordered execution.',
    milestones: [
      {
        id: 'm1',
        title: 'Milestone',
        objective: 'Complete the milestone.',
        successCriteria: 'All slices integrate.',
        slices: [
          {
            id: 'm1-s1',
            title: 'Slice',
            objective: 'Complete the slice.',
            successCriteria: 'All Work integrates.',
            dependsOn: [],
            tasks: Array.from({ length: taskCount }, (_, index) => ({
              id: `m1-s1-t${index + 1}`,
              title: `Work ${index + 1}`,
              objective: `Complete Work ${index + 1}.`,
              kind: 'backend-implementation' as const,
              estimatedMinutes: 10,
              files: [`src/work-${index + 1}.ts`],
              dependsOn: index === 0 ? [] : [`m1-s1-t${index}`],
              acceptanceCriteria: [`Work ${index + 1} is complete.`],
              attachmentIds: []
            }))
          }
        ]
      }
    ]
  }
}

function fixture(): {
  root: string
  database: ReturnType<typeof openKernelDatabase>
  conversation: ConversationService
  drafts: DraftService
  jobs: JobService
  workspaceId: string
  createWorkspace(): string
  createJob(workspaceId?: string, taskCount?: number): Promise<ReturnType<JobService['getJob']>>
  close(): void
} {
  const root = mkdtempSync(join(tmpdir(), 'codetask-job-service-'))
  const database = openKernelDatabase({ filename: ':memory:' })
  database.client
    .prepare(
      `INSERT INTO auth_users
         (id, singleton_key, username, normalized_username, password_hash,
          password_version, created_at_ms, updated_at_ms)
       VALUES (?, 1, 'Alice', 'alice', 'hash', 1, 1, 1)`
    )
    .run(USER_ID)
  let now = 1_000
  let nextId = 0
  let nextWorkspace = 0
  const dependencies = {
    unitOfWork: new SqliteUnitOfWork(database),
    clock: { nowMs: () => now++ },
    ids: { generate: () => `id-${++nextId}` }
  }
  const conversation = new ConversationService(dependencies)
  const drafts = new DraftService({
    ...dependencies,
    assets: new FileSystemDraftAssetStore(
      join(root, 'draft-assets'),
      join(root, 'job-intake-assets')
    )
  })
  const jobs = new JobService(dependencies)

  const createWorkspace = (): string => {
    const number = ++nextWorkspace
    const workspaceRoot = join(root, `workspace-${number}`)
    mkdirSync(workspaceRoot, { recursive: true })
    return conversation.createWorkspace(USER_ID, {
      rootPath: workspaceRoot,
      canonicalKey: workspaceRoot,
      title: `Workspace ${number}`
    }).id
  }
  const workspaceId = createWorkspace()

  return {
    root,
    database,
    conversation,
    drafts,
    jobs,
    workspaceId,
    createWorkspace,
    async createJob(targetWorkspace = workspaceId, taskCount = 2) {
      const draft = drafts.createDraft(USER_ID, {
        workspaceId: targetWorkspace,
        title: 'Ordered Job',
        objective: 'Exercise exact pause, failure and restart positions.',
        requirements: 'Run each Work and enabled gate in sequence.',
        constraints: 'Never use environment variables.',
        acceptanceCriteria: 'Execution is durable and ordered.'
      })
      const generation = drafts.beginGeneration(USER_ID, draft.id)
      const executionTree = drafts.completeGeneration(
        USER_ID,
        draft.id,
        generation.run.id,
        tree(taskCount),
        {
          plannerPrompt: generation.plannerPrompt,
          skillsManual: generation.skillsManual
        }
      )
      const handoff = await drafts.confirmExecutionTree(USER_ID, draft.id, {
        expectedRevision: draft.revision,
        treeId: executionTree.id
      })
      return jobs.acceptHandoff(handoff.id)
    },
    close() {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('durable Job state machine', () => {
  it('expands Work and independently enabled gates into one stable linear order', async () => {
    const f = fixture()
    try {
      const job = await f.createJob()
      assert.deepEqual(
        job.items.map((item) => item.kind),
        [
          'work',
          'work_validation',
          'work',
          'work_validation',
          'slice_validation',
          'milestone_validation'
        ]
      )
      assert.deepEqual(
        job.items.map((item) => item.provider),
        ['codex', 'claude-code', 'codex', 'claude-code', 'opencode', 'cursorcli']
      )
      assert.deepEqual(
        job.items.map((item) => item.sequence),
        [1, 2, 3, 4, 5, 6]
      )
    } finally {
      f.close()
    }
  })

  it('finishes the current item before pausing and resumes at the exact next position', async () => {
    const f = fixture()
    try {
      const job = await f.createJob()
      assert.ok(f.jobs.tryClaim(job.id))
      const first = f.jobs.beginNextItem(USER_ID, job.id)
      assert.ok(first)
      assert.equal(f.jobs.workspaceHasActiveLease(job.workspaceId), true)
      assert.equal(f.jobs.requestPause(USER_ID, job.id).state, 'pause_requested')
      f.jobs.completeWork(USER_ID, job.id, first.item.id, WORK_COMPLETED)

      const paused = f.jobs.getJob(USER_ID, job.id)
      assert.equal(paused.state, 'paused')
      assert.equal(paused.items[0]?.state, 'succeeded')
      assert.equal(paused.items[1]?.state, 'queued')
      assert.equal(f.jobs.workspaceHasActiveLease(job.workspaceId), false)

      assert.equal(f.jobs.continueJob(USER_ID, job.id).state, 'queued')
      assert.ok(f.jobs.tryClaim(job.id))
      const resumed = f.jobs.beginNextItem(USER_ID, job.id)
      assert.equal(resumed?.item.id, paused.items[1]?.id)
      assert.equal(resumed?.item.attempt, 1)
    } finally {
      f.close()
    }
  })

  it('continues a failed or interrupted Job at the same item without replaying success', async () => {
    const f = fixture()
    try {
      const failedJob = await f.createJob()
      assert.ok(f.jobs.tryClaim(failedJob.id))
      const failedItem = f.jobs.beginNextItem(USER_ID, failedJob.id)
      assert.ok(failedItem)
      f.jobs.failItem(USER_ID, failedJob.id, failedItem.item.id, 'job.test_failure', 'boom')
      assert.equal(f.jobs.getJob(USER_ID, failedJob.id).state, 'failed')
      f.jobs.continueJob(USER_ID, failedJob.id)
      assert.ok(f.jobs.tryClaim(failedJob.id))
      const retry = f.jobs.beginNextItem(USER_ID, failedJob.id)
      assert.equal(retry?.item.id, failedItem.item.id)
      assert.equal(retry?.item.attempt, 2)

      f.jobs.interruptRunningItem(USER_ID, failedJob.id, retry!.item.id)
      const interrupted = f.jobs.getJob(USER_ID, failedJob.id)
      assert.equal(interrupted.state, 'paused')
      assert.equal(interrupted.items[0]?.state, 'queued')
      f.jobs.continueJob(USER_ID, failedJob.id)
      assert.ok(f.jobs.tryClaim(failedJob.id))
      assert.equal(f.jobs.beginNextItem(USER_ID, failedJob.id)?.item.id, failedItem.item.id)
    } finally {
      f.close()
    }
  })

  it('reconciles a process restart to paused and keeps the interrupted item queued', async () => {
    const f = fixture()
    try {
      const job = await f.createJob()
      assert.ok(f.jobs.tryClaim(job.id))
      const running = f.jobs.beginNextItem(USER_ID, job.id)
      assert.ok(running)
      assert.equal(f.jobs.reconcileInterrupted(), 1)
      const recovered = f.jobs.getJob(USER_ID, job.id)
      assert.equal(recovered.state, 'paused')
      assert.equal(recovered.activeItemId, null)
      assert.equal(recovered.items[0]?.state, 'queued')
      assert.equal(recovered.items[0]?.error?.code, 'job.interrupted')
      assert.equal(f.jobs.workspaceHasActiveLease(job.workspaceId), false)
    } finally {
      f.close()
    }
  })

  it('inserts bounded repair Work immediately before the same gate and reruns it', async () => {
    const f = fixture()
    try {
      const job = await f.createJob(undefined, 1)
      assert.ok(f.jobs.tryClaim(job.id))
      const work = f.jobs.beginNextItem(USER_ID, job.id)
      assert.equal(work?.item.kind, 'work')
      f.jobs.completeWork(USER_ID, job.id, work!.item.id, WORK_COMPLETED)
      const gate = f.jobs.beginNextItem(USER_ID, job.id)
      assert.equal(gate?.item.kind, 'work_validation')
      f.jobs.completeVerification(USER_ID, job.id, gate!.item.id, {
        status: 'repair',
        summary: 'One bounded repair is needed.',
        evidence: ['a missing edge case'],
        repairTasks: [
          {
            title: 'Cover edge case',
            objective: 'Add the missing bounded behavior.',
            files: ['src/result.ts'],
            acceptanceCriteria: ['The edge case passes.']
          }
        ]
      })

      const repairedPlan = f.jobs.getJob(USER_ID, job.id)
      const repair = repairedPlan.items.find((item) => item.parentItemId === gate!.item.id)
      const queuedGate = repairedPlan.items.find((item) => item.id === gate!.item.id)
      assert.ok(repair)
      assert.equal(repair.kind, 'work')
      assert.equal(repair.sequence + 1, queuedGate?.sequence)
      assert.equal(queuedGate?.state, 'queued')
      assert.equal(queuedGate?.repairGeneration, 1)

      const runningRepair = f.jobs.beginNextItem(USER_ID, job.id)
      assert.equal(runningRepair?.item.id, repair.id)
      f.jobs.completeWork(USER_ID, job.id, repair.id, WORK_COMPLETED)
      const rerun = f.jobs.beginNextItem(USER_ID, job.id)
      assert.equal(rerun?.item.id, gate!.item.id)
      f.jobs.completeVerification(USER_ID, job.id, rerun!.item.id, VERIFIED)
      assert.equal(
        f.jobs.getJob(USER_ID, job.id).items.find((item) => item.id === gate!.item.id)?.state,
        'succeeded'
      )
    } finally {
      f.close()
    }
  })

  it('enforces one workspace lease while allowing two different workspaces', async () => {
    const f = fixture()
    try {
      const first = await f.createJob()
      const sameWorkspace = await f.createJob()
      const otherWorkspace = await f.createJob(f.createWorkspace())
      assert.ok(f.jobs.tryClaim(first.id))
      assert.equal(f.jobs.tryClaim(sameWorkspace.id), null)
      assert.ok(f.jobs.tryClaim(otherWorkspace.id))
      assert.equal(f.jobs.workspaceHasActiveLease(first.workspaceId), true)
      assert.equal(f.jobs.workspaceHasActiveLease(otherWorkspace.workspaceId), true)
    } finally {
      f.close()
    }
  })

  it('prevents deleting a workspace while durable Job history retains it', async () => {
    const f = fixture()
    try {
      const job = await f.createJob()
      assert.throws(
        () => f.jobs.assertWorkspaceRemovalAllowed(USER_ID, job.workspaceId),
        (error: unknown) =>
          error instanceof Error && 'code' in error && error.code === 'job.workspace_retained'
      )
      assert.doesNotThrow(() => f.jobs.assertWorkspaceRemovalAllowed(USER_ID, f.createWorkspace()))
    } finally {
      f.close()
    }
  })

  it('snapshots settings per Job and allows each validation level to be disabled', async () => {
    const f = fixture()
    try {
      const defaults = f.jobs.getSettings(USER_ID)
      const disabled: JobSettings = {
        ...defaults,
        work: { ...defaults.work, provider: 'cursorcli', prompt: 'Snapshot prompt' },
        workValidation: { ...defaults.workValidation, enabled: false },
        sliceValidation: { ...defaults.sliceValidation, enabled: false },
        milestoneValidation: { ...defaults.milestoneValidation, enabled: false }
      }
      f.jobs.updateSettings(USER_ID, disabled, defaults.revision)
      const job = await f.createJob(undefined, 1)
      assert.deepEqual(
        job.items.map((item) => item.kind),
        ['work']
      )
      assert.equal(job.items[0]?.provider, 'cursorcli')

      const current = f.jobs.getSettings(USER_ID)
      f.jobs.updateSettings(
        USER_ID,
        {
          ...current,
          work: { ...current.work, provider: 'codex', prompt: 'Changed later' }
        },
        current.revision
      )
      const unchanged = f.jobs.getJob(USER_ID, job.id)
      assert.equal(unchanged.items[0]?.provider, 'cursorcli')
    } finally {
      f.close()
    }
  })

  it('runs two Jobs concurrently while keeping every Job internally sequential', async () => {
    const f = fixture()
    let module: ReturnType<typeof createJobModule> | null = null
    try {
      const defaults = f.jobs.getSettings(USER_ID)
      f.jobs.updateSettings(
        USER_ID,
        { ...defaults, maxConcurrentJobs: 2 },
        defaults.revision
      )
      const first = await f.createJob(undefined, 1)
      const second = await f.createJob(f.createWorkspace(), 1)
      const calls: Array<{ jobId: string; sequence: number }> = []
      const releaseFirstItems: Array<() => void> = []
      const executor: JobItemExecutor = async (input) => {
        calls.push({ jobId: input.job.id, sequence: input.item.sequence })
        if (input.item.sequence === 1) {
          await new Promise<void>((resolve) => releaseFirstItems.push(resolve))
        }
        return input.item.kind === 'work'
          ? JSON.stringify(WORK_COMPLETED)
          : JSON.stringify(VERIFIED)
      }
      module = createJobModule({
        database: f.database,
        runtimeRoot: join(f.root, 'job-runtime'),
        jobAssetsRoot: join(f.root, 'job-intake-assets'),
        hostEnvironment: {},
        executor
      })
      await module.start()
      await waitFor(() => releaseFirstItems.length === 2)
      assert.equal(new Set(calls.slice(0, 2).map((call) => call.jobId)).size, 2)
      assert.deepEqual(
        calls.slice(0, 2).map((call) => call.sequence),
        [1, 1]
      )

      releaseFirstItems.splice(0).forEach((release) => release())
      await waitFor(
        () =>
          module?.service.getJob(USER_ID, first.id).state === 'succeeded' &&
          module.service.getJob(USER_ID, second.id).state === 'succeeded'
      )
      for (const jobId of [first.id, second.id]) {
        assert.deepEqual(
          calls.filter((call) => call.jobId === jobId).map((call) => call.sequence),
          [1, 2, 3, 4]
        )
      }
    } finally {
      await module?.shutdown()
      f.close()
    }
  })
})
