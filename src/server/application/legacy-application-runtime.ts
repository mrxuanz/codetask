import type { AppContext } from '../context'
import { reconcileOnStartupOnce } from '../conversation/service'
import { pruneOrphanRuntimeTrees } from '../runtime/cleanup'
import { runRetentionJanitorPass } from '../retention'
import { runAuthJanitorPass } from '../auth/janitor'
import { bindStartupWorkloadGate } from '../legacy-control-plane/workload-slot'
import { StartupCoordinator } from './startup-coordinator'
import { SafeLoggerImpl } from './safe-logger'
import type { SchemaGenerationRead } from './cutover-state'
import {
  bootstrapControlPlaneRuntime,
  createControlPlaneRuntime,
  shutdownControlPlaneRuntime,
  type ControlPlaneRuntime
} from './control-plane-runtime'
import type { LegacyApplicationRuntime } from './application-runtime'
import type { ShutdownReason } from './shutdown-coordinator'

export function createLegacyApplicationRuntime(
  ctx: AppContext,
  schemaRead: SchemaGenerationRead
): LegacyApplicationRuntime {
  const logger = new SafeLoggerImpl()
  const controlPlane = createControlPlaneRuntime(ctx)

  const startup = new StartupCoordinator({
    logger,
    stages: [
      {
        name: 'reconcile-workload-slots',
        execute: async () => {
          const { reconcileOrphanWorkloadSlotsOnStartupOnce } = await import(
            '../legacy-control-plane/reconcile'
          )
          await reconcileOrphanWorkloadSlotsOnStartupOnce()
        }
      },
      {
        name: 'reconcile-orphan-jobs',
        execute: async () => {
          const { reconcileOrphanRunningJobsOnStartupOnce } = await import(
            '../legacy-control-plane/reconcile'
          )
          await reconcileOrphanRunningJobsOnStartupOnce()
        }
      },
      {
        name: 'reconcile-planning-sessions',
        execute: async () => {
          const { reconcileOrphanPlanningSessionsOnStartupOnce } = await import(
            '../legacy-control-plane/reconcile'
          )
          await reconcileOrphanPlanningSessionsOnStartupOnce()
        }
      },
      {
        name: 'reconcile-conversation',
        execute: () => reconcileOnStartupOnce()
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
    controlPlane,
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
      result.orphanDesignArtifacts > 0 ||
      result.staleAttachmentDirs > 0 ||
      result.orphanRuntimeTrees > 0 ||
      result.sqliteMaintenance.ran
    ) {
      logger.info('retention startup janitor pass', {
        expiredArtifacts: result.expiredArtifacts,
        orphanAttachments: result.orphanAttachments
      })
    }
  } catch (error: unknown) {
    logger.warn('retention startup janitor failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function startConversationCursorReaper(ctx: AppContext, logger: SafeLoggerImpl): Promise<void> {
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

export async function startLegacyApplicationRuntime(runtime: LegacyApplicationRuntime): Promise<void> {
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

    if (runtime.controlPlane !== null) {
      await bootstrapControlPlaneRuntime(runtime.ctx)
      rollback.push(async () => {
        await shutdownControlPlaneRuntime('app_shutdown', runtime.ctx)
      })
    }

    const { startWorkloadReconciler } = await import('../legacy-control-plane/reconcile')
    startWorkloadReconciler()
    rollback.push(async () => {
      const { stopWorkloadReconciler } = await import('../legacy-control-plane/reconcile')
      stopWorkloadReconciler()
    })

    const executorModule = await import('../legacy-control-plane/executor')
    await executorModule.initJobExecutor(runtime.ctx)

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

export async function shutdownLegacyApplicationRuntime(
  runtime: LegacyApplicationRuntime,
  reason: ShutdownReason
): Promise<void> {
  if (runtime.shutdownPromise !== null) {
    return runtime.shutdownPromise
  }

  runtime.shutdownPromise = (async () => {
    const { stopWorkloadReconciler } = await import('../legacy-control-plane/reconcile')
    stopWorkloadReconciler()

    if (runtime.controlPlane !== null) {
      await shutdownControlPlaneRuntime(reason, runtime.ctx)
    }

    runtime.started = false
  })()

  return runtime.shutdownPromise
}

export async function resetLegacyApplicationRuntimeForTests(
  runtime: LegacyApplicationRuntime
): Promise<void> {
  await shutdownLegacyApplicationRuntime(runtime, 'app_shutdown').catch(() => {})
  runtime.startPromise = null
  runtime.shutdownPromise = null
  runtime.started = false
}
