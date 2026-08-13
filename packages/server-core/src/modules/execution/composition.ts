import type Database from 'better-sqlite3'
import type { AgentRuntime } from '@codetask/agent-runtime'
import { UnsupportedAgentRuntime } from '@codetask/agent-runtime'
import { Hono } from 'hono'
import type { JobSubmissionPort } from '../design/planning/application/planning-application.ts'
import { JobRepository } from './job/infrastructure/job-repository.ts'
import { QueueRepository } from './queue/infrastructure/queue-repository.ts'
import { WorkRepository } from './work/infrastructure/work-repository.ts'
import { PoolRepository } from './pool/infrastructure/pool-repository.ts'
import { VerificationRepository } from './verification/infrastructure/verification-repository.ts'
import { ExecutionOutbox } from './events/execution-outbox.ts'
import { createSubmitJobService, type JobAssetPort } from './job/application/submit-job.ts'
import { QueryJobService } from './job/application/query-job.ts'
import { ControlJobService } from './job/application/control-job.ts'
import { DeleteJobService } from './job/application/delete-job.ts'
import { createClaimNextJobService } from './queue/application/claim-next-job.ts'
import { createWakeScheduler, registerWakeScheduler } from './queue/application/wake-scheduler.ts'
import {
  createDrainPoolService,
  createHeartbeatRunService,
  createReleaseRunService,
  createReconcilePoolService
} from './pool/application/release-run.ts'
import { RuntimeHandleRegistry } from './pool/infrastructure/runtime-handle-registry.ts'
import { FakeAgentRuntime } from './pool/infrastructure/fake-agent-runtime.ts'
import { createAcceptWorkResultService } from './work/application/accept-work-result.ts'
import { createExecuteWorkService } from './work/application/execute-work.ts'
import { createDispatchNextWorkService } from './work/application/dispatch-next-work.ts'
import { decideNextStep } from './work/application/coordinator.ts'
import {
  createVerifyMilestoneService,
  createVerifySliceService
} from './verification/application/verify-slice.ts'
import { createStartupReconcileService } from './recovery/application/startup.ts'
import {
  createExecutionQueueRoute,
  createJobRoutes,
  type ExecutionHttpEnv
} from './job/http/job-routes.ts'
import { LEASE_TTL_MS, newId, nowMs } from './shared.ts'

export type ExecutionModule = {
  submitJob: JobSubmissionPort
  jobs: {
    query: QueryJobService
    control: ControlJobService
    delete: DeleteJobService
  }
  routes: Hono<ExecutionHttpEnv>
  scheduler: {
    wake: () => void
    tick: () => Promise<void>
  }
  startup: () => void
  drain: () => void
  outbox: {
    drainOnce: () => number
  }
}

export function composeExecutionModule(deps: {
  db: Database.Database
  agentRuntime: AgentRuntime
  onEvent?: (jobId: string, eventType: string, payload: unknown, outboxId: string) => void
  leaseOwner?: string
  /** Test override; production refreshes at one third of the lease TTL. */
  heartbeatIntervalMs?: number
  assets?: JobAssetPort
}): ExecutionModule {
  const leaseOwner = deps.leaseOwner ?? newId('execution-host')
  const agentRuntime = deps.agentRuntime

  const jobs = new JobRepository(deps.db)
  const queue = new QueueRepository(deps.db)
  const work = new WorkRepository(deps.db)
  const pool = new PoolRepository(deps.db)
  const verification = new VerificationRepository(deps.db)
  const outbox = new ExecutionOutbox(deps.db, deps.onEvent)
  const handles = new RuntimeHandleRegistry()

  const submitJobService = createSubmitJobService({
    db: deps.db,
    outbox,
    ...(deps.assets ? { assets: deps.assets } : {})
  })
  const acceptResult = createAcceptWorkResultService({ db: deps.db, work, outbox })
  const executeWork = createExecuteWorkService({
    db: deps.db,
    work,
    agentRuntime,
    acceptResult,
    handles,
    ...(deps.assets ? { resolveAttachmentPath: deps.assets.resolveAttachmentPath } : {})
  })
  const dispatchWork = createDispatchNextWorkService({ executeWork })
  const claimNext = createClaimNextJobService({ db: deps.db, outbox, leaseOwner })
  const releaseRun = createReleaseRunService({ db: deps.db, pool })
  const heartbeatRun = createHeartbeatRunService({ pool, leaseOwner })
  const drainPool = createDrainPoolService({ db: deps.db })
  const reconcilePool = createReconcilePoolService({ pool })
  const verifySlice = createVerifySliceService({
    db: deps.db,
    verification,
    outbox,
    work,
    agentRuntime,
    handles
  })
  const verifyMilestone = createVerifyMilestoneService({
    db: deps.db,
    verification,
    outbox,
    agentRuntime,
    handles
  })
  const startupReconcile = createStartupReconcileService({ db: deps.db })

  let ticking = false
  let rerunRequested = false
  let activeRun: { runId: string; jobId: string } | null = null
  let outboxTimer: ReturnType<typeof setInterval> | null = null
  const heartbeatIntervalMs =
    deps.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(LEASE_TTL_MS / 3))

  function abortActiveTurn(reason: string): void {
    if (!activeRun) return
    const handle = handles.get(activeRun.runId)
    handles.abort(activeRun.runId, reason)
    for (const turnId of handle?.turnIds ?? []) {
      void agentRuntime.abort(turnId, reason)
    }
  }

  async function awaitWithRunHeartbeat<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      try {
        heartbeatRun.heartbeat(runId)
      } catch (error) {
        console.error('[execution] run heartbeat failed:', error)
        abortActiveTurn('execution-lease-heartbeat-failed')
      }
    }, heartbeatIntervalMs)
    timer.unref?.()
    try {
      return await task()
    } finally {
      clearInterval(timer)
    }
  }

  async function runCoordinatorSteps(runId: string, jobId: string): Promise<boolean> {
    if (drainPool.isDraining()) return false
    const job = jobs.requireById(jobId)
    if (job.state !== 'running' && job.state !== 'pausing' && job.state !== 'cancelling') {
      return false
    }

    heartbeatRun.heartbeat(runId)

    if (job.state === 'pausing' || job.state === 'cancelling') {
      const handle = handles.get(runId)
      if (handle && handle.turnIds.size > 0) {
        // Turns still active — abort and wait for executors to remove every turn id.
        abortActiveTurn(job.state === 'pausing' ? 'pause' : 'cancel')
        return false
      }
      const now = nowMs()
      if (job.state === 'pausing') {
        deps.db.transaction(() => {
          const updated = jobs.casUpdateState({
            jobId,
            expectedRevision: job.stateRevision,
            next: {
              state: 'paused',
              controlIntent: 'none',
              currentRunId: null,
              updatedAt: now
            }
          })
          outbox.enqueue(jobId, 'job.changed', {
            jobId,
            actorId: job.actorId,
            state: updated.state,
            revision: updated.stateRevision
          })
        })()
      } else {
        deps.db.transaction(() => {
          const updated = jobs.casUpdateState({
            jobId,
            expectedRevision: job.stateRevision,
            next: {
              state: 'cancelled',
              controlIntent: 'none',
              currentRunId: null,
              terminalAt: now,
              updatedAt: now
            }
          })
          deps.db
            .prepare(
              `UPDATE job_work_items SET state = 'cancelled', state_revision = state_revision + 1,
               updated_at = ? WHERE job_id = ? AND generation = ?
               AND state NOT IN ('succeeded', 'failed', 'cancelled')`
            )
            .run(now, jobId, job.executionGeneration)
          outbox.enqueue(jobId, 'job.changed', {
            jobId,
            actorId: job.actorId,
            state: updated.state,
            revision: updated.stateRevision
          })
        })()
      }
      releaseRun.releaseRun(runId, 'control-settled')
      handles.drop(runId)
      activeRun = null
      return false
    }

    const workItems = work.listWork(jobId, job.executionGeneration)
    const dependencies = work.listDependencies(jobId, job.executionGeneration)
    const sliceDependencies = work.listSliceDependencies(jobId, job.executionGeneration)
    const succeededWorkIds = work.succeededWorkIds(jobId, job.executionGeneration)

    const decision = decideNextStep({
      jobId,
      jobState: job.state,
      controlIntent: job.controlIntent,
      generation: job.executionGeneration,
      workItems,
      dependencies,
      sliceDependencies,
      succeededWorkIds,
      verification
    })

    switch (decision.kind) {
      case 'dispatch-work':
        await awaitWithRunHeartbeat(runId, () =>
          Promise.all(
            decision.workIds.map((workId) =>
              dispatchWork.dispatch({
                jobId,
                workId,
                runId,
                workspaceRoot: job.workspaceRoot
              })
            )
          ).then(() => undefined)
        )
        return true
      case 'verify-slice':
        await awaitWithRunHeartbeat(runId, () =>
          verifySlice.verify({
            jobId,
            generation: job.executionGeneration,
            sliceId: decision.sliceId,
            runId
          })
        )
        return true
      case 'verify-milestone':
        await awaitWithRunHeartbeat(runId, () =>
          verifyMilestone.verify({
            jobId,
            generation: job.executionGeneration,
            milestoneId: decision.milestoneId,
            runId
          })
        )
        return true
      case 'complete-job': {
        const now = nowMs()
        deps.db.transaction(() => {
          const updated = jobs.casUpdateState({
            jobId,
            expectedRevision: job.stateRevision,
            next: {
              state: 'succeeded',
              controlIntent: 'none',
              currentRunId: null,
              terminalAt: now,
              updatedAt: now
            }
          })
          outbox.enqueue(jobId, 'job.completed', {
            jobId,
            actorId: job.actorId,
            state: updated.state,
            revision: updated.stateRevision
          })
        })()
        releaseRun.releaseRun(runId, 'completed')
        handles.drop(runId)
        activeRun = null
        return false
      }
      case 'settle-control':
        // Pausing/cancelling while a turn may still be active: abort and wait.
        abortActiveTurn(job.controlIntent === 'pause' ? 'pause' : 'cancel')
        return false
      case 'fail-deadlock': {
        const now = nowMs()
        deps.db.transaction(() => {
          const updated = jobs.casUpdateState({
            jobId,
            expectedRevision: job.stateRevision,
            next: {
              state: 'failed',
              controlIntent: 'none',
              currentRunId: null,
              terminalAt: now,
              lastErrorJson: JSON.stringify({ blockers: decision.blockers }),
              updatedAt: now
            }
          })
          outbox.enqueue(jobId, 'job.changed', {
            jobId,
            actorId: job.actorId,
            state: updated.state,
            revision: updated.stateRevision
          })
        })()
        releaseRun.releaseRun(runId, 'deadlock')
        handles.drop(runId)
        activeRun = null
        return false
      }
      case 'wait':
      default:
        return false
    }
  }

  async function tick(): Promise<void> {
    if (drainPool.isDraining()) return
    if (ticking) {
      rerunRequested = true
      return
    }
    ticking = true
    try {
      do {
        rerunRequested = false
        reconcilePool.reconcile()

        if (!activeRun) {
          const claimed = claimNext.claimNext()
          if (claimed) {
            activeRun = claimed
            handles.register(claimed.runId)
          }
        }

        if (activeRun) {
          let progressed = true
          let guard = 0
          while (progressed && activeRun && !drainPool.isDraining() && guard < 100) {
            guard += 1
            progressed = await runCoordinatorSteps(activeRun.runId, activeRun.jobId)
          }
        }
      } while (rerunRequested && !drainPool.isDraining())
    } finally {
      ticking = false
    }
  }

  const wake = createWakeScheduler(() => {
    void tick().catch((error) => {
      console.error('[execution] scheduler tick failed:', error)
    })
  })
  registerWakeScheduler(wake)

  const query = new QueryJobService(jobs, queue, work, verification)
  const control = new ControlJobService(deps.db, jobs, queue, outbox, wake, (jobId, reason) => {
    if (!activeRun || activeRun.jobId !== jobId) return
    abortActiveTurn(reason)
  })
  const deleteJob = new DeleteJobService(deps.db, jobs, outbox, deps.assets)

  const routes = new Hono<ExecutionHttpEnv>()
  routes.route('/jobs', createJobRoutes({ query, control, deleteJob, queue }))
  routes.route('/execution-queue', createExecutionQueueRoute({ queue }))

  const submitJobPort: JobSubmissionPort = {
    accept: (submission) =>
      submitJobService.accept(submission).then((result) => {
        wake()
        return result
      })
  }

  return {
    submitJob: submitJobPort,
    jobs: { query, control, delete: deleteJob },
    routes,
    scheduler: { wake, tick },
    startup: () => {
      startupReconcile.run()
      outbox.drainOnce()
      if (!outboxTimer) {
        outboxTimer = setInterval(() => outbox.drainOnce(), 500)
        outboxTimer.unref?.()
      }
      wake()
    },
    drain: () => {
      if (outboxTimer) {
        clearInterval(outboxTimer)
        outboxTimer = null
      }
      outbox.drainOnce()
      drainPool.drain()
      handles.dropAll()
    },
    outbox: {
      drainOnce: () => outbox.drainOnce()
    }
  }
}

export { UnsupportedAgentRuntime, FakeAgentRuntime }
export { ScriptedAgentRuntime } from './pool/infrastructure/scripted-agent-runtime.ts'
