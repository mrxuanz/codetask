import type { AppContext } from '../context'
import { reconcileOnStartupOnce } from '../conversation/service'
import { pruneOrphanRuntimeTrees } from '../runtime/cleanup'
import { runRetentionJanitorPass } from '../retention/lifecycle'
import { runAuthJanitorPass } from '../auth/janitor'
import { bindStartupWorkloadGate } from '../legacy-control-plane/workload-slot'
import { StartupCoordinator } from './startup-coordinator'
import { SafeLoggerImpl } from './safe-logger'
import type { SchemaGenerationRead } from './cutover-state'
import type { LegacyApplicationRuntime } from './application-runtime'
import type { ShutdownReason } from './shutdown-coordinator'

export function createLegacyApplicationRuntime(
  ctx: AppContext,
  schemaRead: SchemaGenerationRead
): LegacyApplicationRuntime {
  const logger = new SafeLoggerImpl()

  const startup = new StartupCoordinator({
    logger,
    stages: [
      {
        name: 'scrub-runtime-credentials',
        execute: async () => {
          const { dataPaths } = await import('../data-paths')
          const { scrubCredentialSnapshotsInTree } =
            await import('../sandbox/provider-auth/snapshot-manifest')
          const scrubbed = scrubCredentialSnapshotsInTree(dataPaths(ctx.dataDir).runtimes)
          if (scrubbed.manifests > 0 || scrubbed.rejectedPaths > 0) {
            logger.info('scrubbed provider credential snapshots on startup', { ...scrubbed })
          }
        }
      },
      {
        // FIX-PLAN F3-B (§8.5): fence stale task attempts from a dead process to `interrupted`
        // before any Job is resumed, so resume creates a fresh attempt under the same identity.
        name: 'interrupt-orphan-task-attempts',
        execute: async () => {
          const { markAllRunningAttemptsInterrupted } =
            await import('../legacy-control-plane/task-attempts')
          const changed = markAllRunningAttemptsInterrupted()
          if (changed > 0) {
            logger.info('interrupted orphan task attempts on startup', { count: changed })
          }
        }
      },
      {
        name: 'reclaim-workspace-leases',
        execute: async () => {
          const { reclaimStaleWorkspaceLeasesOnStartup } =
            await import('../legacy-control-plane/workspace-lease-store')
          const changed = reclaimStaleWorkspaceLeasesOnStartup()
          if (changed > 0) {
            logger.info('reclaimed stale workspace leases on startup', { count: changed })
          }
        }
      },
      {
        name: 'resume-deletion-requests',
        execute: async () => {
          const { resumePendingDeletionRequestsOnStartup } =
            await import('../legacy-control-plane/deletion-coordinator')
          await resumePendingDeletionRequestsOnStartup()
        }
      },
      {
        name: 'reconcile-workload-slots',
        execute: async () => {
          const { reconcileOrphanWorkloadSlotsOnStartupOnce } =
            await import('../legacy-control-plane/reconcile')
          await reconcileOrphanWorkloadSlotsOnStartupOnce()
        }
      },
      {
        name: 'reconcile-orphan-jobs',
        execute: async () => {
          const { reconcileOrphanRunningJobsOnStartupOnce } =
            await import('../legacy-control-plane/reconcile')
          // Startup owns the workload gate. Advancing the queue from inside this stage would wait
          // on that same gate and deadlock, so defer it until startup and executor init complete.
          await reconcileOrphanRunningJobsOnStartupOnce({ deferQueueAdvance: true })
        }
      },
      {
        name: 'reconcile-planning-sessions',
        execute: async () => {
          const { reconcileOrphanPlanningSessionsOnStartupOnce } =
            await import('../legacy-control-plane/reconcile')
          await reconcileOrphanPlanningSessionsOnStartupOnce()
        }
      },
      {
        name: 'reconcile-conversation',
        execute: () => reconcileOnStartupOnce()
      },
      {
        name: 'reconcile-conversation-turns',
        execute: async () => {
          const { reconcileConversationTurnsOnStartup } = await import('../conversation/turn-queue')
          const result = reconcileConversationTurnsOnStartup()
          if (result.failed > 0 || result.cancelled > 0) {
            logger.info('reconciled orphan conversation turns', result)
          }
        }
      },
      {
        name: 'prune-runtime-trees',
        execute: async () => {
          const result = await pruneOrphanRuntimeTrees(ctx.dataDir, ctx.db)
          if (result.removedPaths.length > 0) {
            logger.info('pruned orphan runtime trees', { count: result.removedPaths.length })
          }
        }
      }
    ]
  })

  bindStartupWorkloadGate(startup.ensureReady())

  return {
    kind: 'legacy',
    ctx,
    schemaRead,
    startup,
    started: false,
    startPromise: null,
    shutdownPromise: null
  }
}

async function runRetentionStartupPass(logger: SafeLoggerImpl): Promise<void> {
  try {
    const result = await runRetentionJanitorPass()
    if (
      result.expiredArtifacts > 0 ||
      result.orphanAttachments > 0 ||
      result.staleRuntimes > 0 ||
      result.completedTaskRuntimes > 0 ||
      result.staleAttachmentDirs > 0 ||
      result.orphanRuntimeTrees > 0 ||
      result.sqliteMaintenance.ran
    ) {
      logger.info('retention startup janitor pass', {
        expiredArtifacts: result.expiredArtifacts,
        orphanAttachments: result.orphanAttachments,
        completedTaskRuntimes: result.completedTaskRuntimes
      })
    }
  } catch (error: unknown) {
    logger.warn('retention startup janitor failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function startConversationCursorReaper(
  ctx: AppContext,
  logger: SafeLoggerImpl
): Promise<void> {
  try {
    const module = await import('../agent-runtime/cursor-acp/conversation-cursor-reaper')
    module.configureConversationCursorReaper({
      isThreadInflight: (threadId) => ctx.runtimeRegistry.isThreadInflight(threadId)
    })
    module.startConversationCursorReaper()
  } catch (error: unknown) {
    logger.warn('conversation session reaper startup failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export async function startLegacyApplicationRuntime(
  runtime: LegacyApplicationRuntime
): Promise<void> {
  if (runtime.startPromise !== null) {
    return runtime.startPromise
  }

  runtime.startPromise = startLegacyApplicationRuntimeOnce(runtime).catch((error: unknown) => {
    runtime.startPromise = null
    throw error
  })

  return runtime.startPromise
}

async function startLegacyApplicationRuntimeOnce(runtime: LegacyApplicationRuntime): Promise<void> {
  const logger = new SafeLoggerImpl()
  const rollback: Array<() => Promise<void>> = []

  try {
    await runtime.startup.ensureReady()

    const { startWorkloadReconciler } = await import('../legacy-control-plane/reconcile')
    startWorkloadReconciler()
    rollback.push(async () => {
      const { stopWorkloadReconciler } = await import('../legacy-control-plane/reconcile')
      stopWorkloadReconciler()
    })

    const executorModule = await import('../legacy-control-plane/executor')
    await executorModule.initJobExecutor(runtime.ctx)

    // Startup reconcile repaired durable state without entering the gated queue. Once every stage
    // is complete and the executor is initialized, resume an interrupted running job (or FIFO work).
    const { advanceAllQueues } = await import('../legacy-control-plane/queue-coordinator')
    await advanceAllQueues()
    const { advanceTurnQueue } = await import('../conversation/turn-queue')
    await advanceTurnQueue()

    await Promise.all([
      runRetentionStartupPass(logger),
      startConversationCursorReaper(runtime.ctx, logger),
      runAuthJanitorPass().catch(() => {})
    ])

    runtime.started = true
  } catch (error: unknown) {
    for (const stop of rollback.reverse()) {
      await stop().catch(() => {})
    }
    throw error
  }
}

/**
 * FIX-PLAN F3-C (§8.4): graceful Legacy shutdown. Same promise serves Electron before-quit,
 * SIGINT/SIGTERM and server stop (see `getShutdownPromise`/`gracefulShutdown`).
 *
 * Order:
 *   1. enter draining (reject new claim / plan-confirm promotion)
 *   2. stop queue/reconciler timers
 *   3. request running turns to stop at a safe checkpoint, wait for provider child/handle closed,
 *      mark the in-flight attempt `interrupted` (NOT failed), end the old run, release slot + lease
 *   4. close Cursor ACP scopes (conversation + job) and stop the idle reaper
 *   5. keep the Job auto-recoverable (`running`), then flush durable events
 */
export async function shutdownLegacyApplicationRuntime(
  runtime: LegacyApplicationRuntime,
  reason: ShutdownReason
): Promise<void> {
  if (runtime.shutdownPromise !== null) {
    return runtime.shutdownPromise
  }

  runtime.shutdownPromise = runShutdown(runtime, reason)
  return runtime.shutdownPromise
}

async function runShutdown(
  runtime: LegacyApplicationRuntime,
  reason: ShutdownReason
): Promise<void> {
  const logger = new SafeLoggerImpl()
  logger.info('legacy shutdown started', { reason })

  // 1. Enter draining: reject new claims / promotions.
  const { beginDraining } = await import('../legacy-control-plane/shutdown-state')
  beginDraining()

  // 2. Stop queue/reconciler timers.
  const { stopWorkloadReconciler } = await import('../legacy-control-plane/reconcile')
  stopWorkloadReconciler()

  // 3. Drain in-flight execution runs at a safe checkpoint.
  await drainActiveExecutionRuns(logger)

  // 4. Close Cursor ACP conversation/job scopes (core switch / delete already close per-scope).
  await closeCursorAcpRuntimes(logger)

  // 5. Flush durable events (Legacy emits in-memory SSE; nothing durable to persist here yet).
  await flushDurableEvents(logger)

  runtime.started = false
  logger.info('legacy shutdown completed')
}

async function closeCursorAcpRuntimes(logger: SafeLoggerImpl): Promise<void> {
  const failures: unknown[] = []
  try {
    const reaper = await import('../agent-runtime/cursor-acp/conversation-cursor-reaper')
    reaper.stopConversationCursorReaper()
    const { getCursorProviderRuntimeRegistry } =
      await import('../agent-runtime/cursor-acp/runtime-registry')
    const { closeAllJobCursorSandboxes } = await import('../sandbox/job-cursor-pool')
    const { shutdownSandboxSupervisor } = await import('../sandbox/supervisor-manager')
    const results = await Promise.allSettled([
      getCursorProviderRuntimeRegistry().closeAll(),
      closeAllJobCursorSandboxes(),
      shutdownSandboxSupervisor()
    ])
    failures.push(
      ...results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
    )
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) {
    logger.warn('close Cursor ACP runtimes failed', {
      errors: failures.map((error) => (error instanceof Error ? error.message : String(error)))
    })
  }
}

async function drainActiveExecutionRuns(logger: SafeLoggerImpl): Promise<void> {
  try {
    const { listActiveWorkloadSlots } = await import('../legacy-control-plane/workload-slot-store')
    const { stopRunLifecycle } = await import('../legacy-control-plane/run-lifecycle')
    const { markRunningAttemptsInterruptedForJob } =
      await import('../legacy-control-plane/task-attempts')

    const slots = await listActiveWorkloadSlots({})
    const executionSlots = slots.filter((slot) => slot.kind === 'execution')

    for (const slot of executionSlots) {
      try {
        // Mark the interrupted attempt BEFORE tearing the run down so a late writer cannot
        // resurrect it as completed/failed.
        if (slot.ownerKind === 'thread_job') {
          markRunningAttemptsInterruptedForJob(slot.ownerId)
        }
        // Request stop → wait provider child/handle closed → end run → release slot + lease.
        // The Job row is left `running` (auto-recoverable); we never mark it failed here.
        await stopRunLifecycle(slot.runId, 'app_shutdown')
      } catch (error) {
        logger.warn('drain execution run failed', {
          runId: slot.runId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  } catch (error) {
    logger.warn('drain active execution runs failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function flushDurableEvents(logger: SafeLoggerImpl): Promise<void> {
  // Legacy delivers progress via the in-memory SSE JobEventBus; there is no durable outbox in the
  // Legacy generation, so there is nothing to flush. Kept as an explicit, documented step so the
  // shutdown contract stays complete and easy to extend.
  void logger
}

export async function resetLegacyApplicationRuntimeForTests(
  runtime: LegacyApplicationRuntime
): Promise<void> {
  await shutdownLegacyApplicationRuntime(runtime, 'app_shutdown').catch(() => {})
  const { endDraining } = await import('../legacy-control-plane/shutdown-state')
  endDraining()
  runtime.startPromise = null
  runtime.shutdownPromise = null
  runtime.started = false
}
