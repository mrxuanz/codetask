import type { AppContext } from '../context'
import { pruneOrphanRuntimeTrees } from '../runtime/cleanup'
import { runRetentionJanitorPass } from '../retention/lifecycle'
import { runAuthJanitorPass } from '../auth/janitor'
import { StartupCoordinator } from './startup-coordinator'
import { SafeLoggerImpl } from './safe-logger'
import type { ApplicationRuntime } from './application-runtime'
import type { ShutdownReason } from './shutdown-types'

export function createHostApplicationRuntime(ctx: AppContext): ApplicationRuntime {
  const logger = new SafeLoggerImpl()

  const startup = new StartupCoordinator({
    logger,
    stages: [
      {
        name: 'reclaim-workspace-leases',
        execute: async () => {
          const { reclaimStaleWorkspaceLeasesOnStartup } =
            await import('../infra/workspace-lease-store')
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
            await import('../infra/deletion-coordinator')
          await resumePendingDeletionRequestsOnStartup()
        }
      },
      {
        name: 'reconcile-conversation-module',
        execute: async () => {
          const { getOrComposeConversation } = await import('../design-module')
          getOrComposeConversation(ctx).startup()
        }
      },
      {
        name: 'prune-runtime-trees',
        execute: async () => {
          const result = await pruneOrphanRuntimeTrees(ctx.dataDir)
          if (result.removedPaths.length > 0) {
            logger.info('pruned orphan runtime trees', { count: result.removedPaths.length })
          }
        }
      }
    ]
  })

  return {
    ctx,
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
      result.legacyRuntimesRemoved > 0 ||
      result.staleAttachmentDirs > 0 ||
      result.sqliteMaintenance.ran
    ) {
      logger.info('retention startup janitor pass', {
        expiredArtifacts: result.expiredArtifacts,
        orphanAttachments: result.orphanAttachments,
        legacyRuntimesRemoved: result.legacyRuntimesRemoved
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
      isConversationInflight: (conversationId) =>
        ctx.runtimeRegistry.isConversationInflight(conversationId)
    })
    module.startConversationCursorReaper()
  } catch (error: unknown) {
    logger.warn('conversation session reaper startup failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export async function startHostApplicationRuntime(runtime: ApplicationRuntime): Promise<void> {
  if (runtime.startPromise !== null) {
    return runtime.startPromise
  }

  runtime.startPromise = startHostApplicationRuntimeOnce(runtime).catch((error: unknown) => {
    runtime.startPromise = null
    throw error
  })

  return runtime.startPromise
}

async function startHostApplicationRuntimeOnce(runtime: ApplicationRuntime): Promise<void> {
  const logger = new SafeLoggerImpl()

  await runtime.startup.ensureReady()

  const { getOrComposeExecution, getOrComposeConversation } = await import('../design-module')
  getOrComposeExecution(runtime.ctx).startup()
  getOrComposeConversation(runtime.ctx).startup()

  await Promise.all([
    runRetentionStartupPass(logger),
    startConversationCursorReaper(runtime.ctx, logger),
    runAuthJanitorPass().catch(() => {})
  ])

  runtime.started = true
}

export async function shutdownHostApplicationRuntime(
  runtime: ApplicationRuntime,
  reason: ShutdownReason
): Promise<void> {
  if (runtime.shutdownPromise !== null) {
    return runtime.shutdownPromise
  }

  runtime.shutdownPromise = runShutdown(runtime, reason)
  return runtime.shutdownPromise
}

async function runShutdown(runtime: ApplicationRuntime, reason: ShutdownReason): Promise<void> {
  const logger = new SafeLoggerImpl()
  logger.info('application shutdown started', { reason })

  try {
    const { getOrComposeExecution } = await import('../design-module')
    getOrComposeExecution(runtime.ctx).drain()
  } catch (error) {
    logger.warn('execution drain failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }

  await closeCursorAcpRuntimes(logger)
  runtime.started = false
  logger.info('application shutdown completed')
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

export async function resetHostApplicationRuntimeForTests(
  runtime: ApplicationRuntime
): Promise<void> {
  await shutdownHostApplicationRuntime(runtime, 'app_shutdown').catch(() => {})
  runtime.startPromise = null
  runtime.shutdownPromise = null
  runtime.started = false
}
