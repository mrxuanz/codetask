import { getRunController, markRunCancelling, releaseWorkloadSlot } from './workload-slot-store'
import {
  cancelRun,
  closeRunRuntime,
  hardKill,
  stopRun,
  waitClosed,
  type RuntimeHandle
} from './runtime-supervisor'

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
  return {
    cancelGraceMs: Number(process.env.CODETASK_RUN_CANCEL_GRACE_MS ?? 10_000),
    killGraceMs: Number(process.env.CODETASK_RUN_KILL_GRACE_MS ?? 5_000)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function stopRunLifecycle(
  runId: string,
  reason: string,
  deps: RunLifecycleDependencies = {}
): Promise<void> {
  const config = runLifecycleConfig()
  const doCancel = deps.cancelRun ?? cancelRun
  const doStop = deps.stopRun ?? stopRun
  const doKill = deps.hardKill ?? hardKill
  const doWaitClosed = deps.waitClosed ?? waitClosed
  const sleep = deps.sleep ?? defaultSleep

  const run = await markRunCancelling(runId, reason)
  if (!run) {
    await releaseWorkloadSlot(runId, { reason, status: 'released' }).catch(() => {})
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

  await doWaitClosed(runId, config.killGraceMs + 5_000).catch((error) => {
    console.warn('[run-lifecycle] waitClosed failed', runId, error)
  })

  await closeRunRuntime(runId).catch(() => {})
  await releaseWorkloadSlot(runId, { reason, status: 'released' }).catch((error) => {
    console.warn('[run-lifecycle] release slot failed', runId, error)
  })
}

export function scheduleStopRunLifecycle(runId: string, reason: string): void {
  void stopRunLifecycle(runId, reason).catch((error) => {
    console.warn('[run-lifecycle] unhandled stop lifecycle error', runId, error)
  })
}

export async function registerRunRuntime(
  runId: string,
  handle: RuntimeHandle
): Promise<void> {
  const { registerRunRuntime: register } = await import('./runtime-supervisor')
  register(runId, handle)
}

export async function closeAndReleaseWorkloadSlot(
  runId: string,
  reason: string
): Promise<void> {
  await closeRunRuntime(runId).catch(() => {})
  await releaseWorkloadSlot(runId, { reason, status: 'released' }).catch(() => {})
}

export async function stopAndReleaseWorkloadSlot(
  runId: string,
  reason: string,
  deps?: RunLifecycleDependencies
): Promise<void> {
  await stopRunLifecycle(runId, reason, deps)
}

export type PlanningRunOutcome = 'success' | 'failure' | 'user_stopped'

export async function finishPlanningRunLifecycle(
  runId: string,
  reason: string,
  outcome: PlanningRunOutcome
): Promise<void> {
  const { isRunActive } = await import('./workload-slot-store')
  if (!(await isRunActive(runId))) {
    await closeRunRuntime(runId).catch(() => {})
    return
  }

  if (outcome === 'success') {
    await closeAndReleaseWorkloadSlot(runId, reason)
    return
  }

  await stopAndReleaseWorkloadSlot(runId, reason)
}
