import {
  getRunController,
  markRunCancelling,
  markRunQuarantined,
  releaseWorkloadSlot
} from './workload-slot-store'
import {
  cancelRun,
  closeRunRuntime,
  hardKill,
  stopRun,
  waitClosed,
  type RuntimeHandle
} from './runtime-supervisor'
import { getAppConfig } from '../bootstrap'

export interface RunLifecycleConfig {
  cancelGraceMs: number
  killGraceMs: number
}

export interface RunLifecycleDependencies {
  cancelRun?: (runId: string, reason: string) => Promise<void>
  stopRun?: (runId: string, reason: string) => Promise<void>
  hardKill?: (runId: string) => Promise<void>
  waitClosed?: (runId: string, timeoutMs?: number) => Promise<void>
  sleep?: (ms: number) => Promise<void>
}

export function runLifecycleConfig(): RunLifecycleConfig {
  return getAppConfig().execution.runLifecycle
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function closeRunRuntimeOrQuarantine(runId: string, reason: string): Promise<void> {
  try {
    await closeRunRuntime(runId)
  } catch (error) {
    await markRunQuarantined(runId, {
      reason,
      detail: error instanceof Error ? error.message : String(error)
    }).catch((quarantineError) => {
      console.warn('[run-lifecycle] quarantine after close failure failed', runId, quarantineError)
    })
    throw error
  }
}

export async function stopRunLifecycle(
  runId: string,
  reason: string,
  deps: RunLifecycleDependencies = {},
  options: { skipRelease?: boolean } = {}
): Promise<void> {
  const config = runLifecycleConfig()
  const doCancel = deps.cancelRun ?? cancelRun
  const doStop = deps.stopRun ?? stopRun
  const doKill = deps.hardKill ?? hardKill
  const doWaitClosed = deps.waitClosed ?? waitClosed
  const sleep = deps.sleep ?? defaultSleep

  const run = await markRunCancelling(runId, reason)
  if (!run) {
    if (!options.skipRelease) {
      await releaseWorkloadSlot(runId, { reason, status: 'released' }).catch(() => {})
    }
    return
  }

  const controller = getRunController(runId)
  if (controller && !controller.signal.aborted) {
    try {
      controller.abort(reason)
    } catch {
      // ignore
    }
  }

  await doCancel(runId, reason).catch((error) => {
    console.warn('[run-lifecycle] cancel failed', runId, error)
  })

  if (config.cancelGraceMs > 0) {
    await sleep(config.cancelGraceMs)
  }

  await doStop(runId, reason).catch((error) => {
    console.warn('[run-lifecycle] stop failed', runId, error)
  })

  if (config.killGraceMs > 0) {
    await sleep(config.killGraceMs)
  }

  await doKill(runId).catch((error) => {
    console.warn('[run-lifecycle] hardKill failed', runId, error)
  })

  try {
    await doWaitClosed(runId, config.killGraceMs + 5_000)
  } catch (error) {
    await markRunQuarantined(runId, {
      reason: 'child_close_unconfirmed',
      detail: error instanceof Error ? error.message : String(error)
    })
    throw error
  }

  await closeRunRuntimeOrQuarantine(runId, 'child_close_failed')

  if (!options.skipRelease) {
    await releaseWorkloadSlot(runId, { reason, status: 'released' }).catch((error) => {
      console.warn('[run-lifecycle] release slot failed', runId, error)
    })
  }
}

export function scheduleStopRunLifecycle(runId: string, reason: string): void {
  void stopRunLifecycle(runId, reason).catch((error) => {
    console.warn('[run-lifecycle] unhandled stop lifecycle error', runId, error)
  })
}

export async function registerRunRuntime(runId: string, handle: RuntimeHandle): Promise<void> {
  const { registerRunRuntime: register } = await import('./runtime-supervisor')
  register(runId, handle)
}

export async function closeAndReleaseWorkloadSlot(runId: string, reason: string): Promise<void> {
  await closeRunRuntimeOrQuarantine(runId, 'child_close_failed')
  await releaseWorkloadSlot(runId, { reason, status: 'released' })
}

export async function stopAndReleaseWorkloadSlot(
  runId: string,
  reason: string,
  deps?: RunLifecycleDependencies
): Promise<void> {
  await stopRunLifecycle(runId, reason, deps)
}

export type ExecutionRunOutcome = 'success' | 'failure'

export interface ExecutionRunLifecycleDependencies extends RunLifecycleDependencies {
  finalizeExecution?: (input: { username: string; jobId: string }) => Promise<void>
  markExecutionDone?: (input: { username: string; jobId: string; runId: string }) => Promise<void>
}

export async function finishExecutionRunLifecycle(
  runId: string,
  input: {
    username: string
    jobId: string
    reason: string
    outcome: ExecutionRunOutcome
  },
  deps: ExecutionRunLifecycleDependencies = {}
): Promise<void> {
  const { clearExecutionRunId, isRunActive, releaseWorkloadSlot } =
    await import('./workload-slot-store')
  const finalizeExecution =
    deps.finalizeExecution ??
    (async (payload: { username: string; jobId: string }) => {
      const { finalizeJobExecution } = await import('./finalize-execution')
      await finalizeJobExecution(payload)
    })
  const markExecutionDone =
    deps.markExecutionDone ??
    (async (payload: { username: string; jobId: string; runId: string }) => {
      const { markJobExecutionDone } = await import('./controls')
      await markJobExecutionDone(payload.jobId, payload.username, payload.runId)
    })

  const active = await isRunActive(runId)
  if (active) {
    if (input.outcome === 'failure') {
      await stopRunLifecycle(runId, input.reason, deps, { skipRelease: true })
    } else {
      await closeRunRuntimeOrQuarantine(runId, 'child_close_failed')
    }
  } else {
    await closeRunRuntimeOrQuarantine(runId, 'child_close_failed')
  }

  await finalizeExecution({ username: input.username, jobId: input.jobId })
  await markExecutionDone({
    username: input.username,
    jobId: input.jobId,
    runId
  })

  if (active) {
    await releaseWorkloadSlot(runId, { reason: input.reason })
  }
  clearExecutionRunId(input.jobId)

  // finalize often runs while the slot is still held and defers runtime cleanup; retry now.
  await retryTerminalJobRuntimeCleanup(input.username, input.jobId)
}

async function retryTerminalJobRuntimeCleanup(username: string, jobId: string): Promise<void> {
  try {
    const { getAppContext } = await import('../bootstrap')
    const { getUserJob } = await import('./repository')
    const { cleanupJobRuntimeTreeIfTerminal, isDeferredCleanupResult, isTerminalJobStatus } =
      await import('../runtime/cleanup')
    const ctx = getAppContext()
    const job = await getUserJob(username, jobId)
    if (!job || !isTerminalJobStatus(job.status)) return
    const result = await cleanupJobRuntimeTreeIfTerminal(
      ctx.dataDir,
      job.threadId,
      jobId,
      job.status
    )
    if (isDeferredCleanupResult(result)) {
      console.warn('[jobs] terminal runtime cleanup still deferred after slot release', jobId, result)
    }
  } catch (error) {
    console.warn('[jobs] post-release terminal runtime cleanup failed', jobId, error)
  }
}

export type PlanningRunOutcome = 'success' | 'failure' | 'user_stopped'

export async function finishPlanningRunLifecycle(
  runId: string,
  reason: string,
  outcome: PlanningRunOutcome
): Promise<void> {
  const { isRunActive } = await import('./workload-slot-store')
  if (!(await isRunActive(runId))) {
    await closeRunRuntimeOrQuarantine(runId, 'child_close_failed')
    return
  }

  if (outcome === 'success' || outcome === 'failure') {
    // Planner turn already ended; release immediately so the planning queue can advance.
    await closeAndReleaseWorkloadSlot(runId, reason)
    return
  }

  await stopAndReleaseWorkloadSlot(runId, reason)
}
