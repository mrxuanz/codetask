import { randomUUID } from 'crypto'
import { JobEventBus, RuntimeRegistry, SettingsStore, type AppContext } from './context'
import { JobExecutionRuntimeRegistry } from './context/job-execution-runtime'
import { createDatabase, closeDatabaseForTests } from './db'
import {
  reconcileOrphanRunningJobsOnStartupOnce,
  reconcileOrphanPlanningSessionsOnStartupOnce,
  reconcileOrphanWorkloadSlotsOnStartupOnce,
  startWorkloadReconciler,
  stopWorkloadReconcilerForTests
} from './jobs/reconcile'
import { bindStartupWorkloadGate } from './jobs/workload-slot'
import { reconcileOnStartupOnce } from './conversation/service'
import { pruneOrphanRuntimeTrees } from './runtime/cleanup'
import { runRetentionJanitorPass, startRetentionJanitor, stopRetentionJanitor } from './retention'
import { getOrCreateAuthSecret } from './auth/secret'
import { startAuthJanitor, stopAuthJanitor, runAuthJanitorPass } from './auth/janitor'
import { StartupCoordinator } from './application/startup-coordinator'
import { SafeLoggerImpl } from './application/safe-logger'
import { LEGACY_RESUME_RUNNING_DISABLED } from './application/legacy-resume-running-disabled'

export type { AppContext } from './context'

export type AppMode = 'desktop' | 'server'

export interface BootstrapOptions {
  dataDir: string
  mode?: AppMode
}

let appContext: AppContext | null = null
const startupTasks = new Set<Promise<unknown>>()
let startupCoordinator: StartupCoordinator | null = null
const bootstrapLogger = new SafeLoggerImpl()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function trackStartupTask<T>(promise: Promise<T>): Promise<T> {
  const tracked = promise.finally(() => {
    startupTasks.delete(tracked)
  })
  startupTasks.add(tracked)
  return tracked
}

async function waitForStartupTasksForTests(): Promise<void> {
  while (startupTasks.size > 0) {
    await Promise.allSettled([...startupTasks])
  }
}

async function waitForPlanningToDrainForTests(ctx: AppContext): Promise<void> {
  const deadline = Date.now() + 5_000
  while (ctx.runtimeRegistry.hasInflightPlanning() && Date.now() < deadline) {
    await sleep(25)
  }
  if (ctx.runtimeRegistry.hasInflightPlanning()) {
    bootstrapLogger.warn('[tests] reset while planning runtime is still active')
  }
}

export function getAppContext(): AppContext {
  if (!appContext) {
    throw new Error('Runtime not bootstrapped')
  }
  return appContext
}

export function getStartupCoordinator(): StartupCoordinator | null {
  return startupCoordinator
}

export function bootstrapRuntime(options: BootstrapOptions): AppContext {
  if (appContext) {
    return appContext
  }

  void LEGACY_RESUME_RUNNING_DISABLED

  const db = createDatabase(options.dataDir)
  const mode = options.mode ?? 'desktop'

  const settings = new SettingsStore(options.dataDir)
  const authSecret = getOrCreateAuthSecret(options.dataDir)

  const bootId = randomUUID()

  appContext = {
    dataDir: options.dataDir,
    db,
    settings,
    security: {
      mode,
      authSecret
    },
    eventBus: new JobEventBus(),
    runtimeRegistry: new RuntimeRegistry(),
    executionRuntime: new JobExecutionRuntimeRegistry(),
    bootId
  }
  process.env.CODETASK_DATA_DIR = options.dataDir

  const ctx = appContext

  startupCoordinator = new StartupCoordinator({
    logger: bootstrapLogger,
    stages: [
      {
        name: 'reconcile-workload-slots',
        execute: () => reconcileOrphanWorkloadSlotsOnStartupOnce()
      },
      {
        name: 'reconcile-orphan-jobs',
        execute: () => reconcileOrphanRunningJobsOnStartupOnce()
      },
      {
        name: 'reconcile-planning-sessions',
        execute: () => reconcileOrphanPlanningSessionsOnStartupOnce()
      },
      {
        name: 'reconcile-conversation',
        execute: () => reconcileOnStartupOnce()
      },
      {
        name: 'prune-runtime-trees',
        execute: async () => {
          const result = await pruneOrphanRuntimeTrees(options.dataDir, db)
          if (result.removedPaths.length > 0) {
            bootstrapLogger.info('pruned orphan runtime trees', {
              count: result.removedPaths.length
            })
          }
        }
      }
    ]
  })

  const startupReconcile = trackStartupTask(
    startupCoordinator.ensureReady().catch((error: unknown) => {
      bootstrapLogger.error('startup coordinator failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    })
  )

  bindStartupWorkloadGate(startupReconcile)

  trackStartupTask(
    runRetentionJanitorPass()
      .then((result) => {
        if (
          result.expiredArtifacts > 0 ||
          result.orphanAttachments > 0 ||
          result.staleRuntimes > 0 ||
          result.orphanDesignArtifacts > 0 ||
          result.staleAttachmentDirs > 0 ||
          result.orphanRuntimeTrees > 0 ||
          result.sqliteMaintenance.ran
        ) {
          bootstrapLogger.info('retention startup janitor pass', {
            expiredArtifacts: result.expiredArtifacts,
            orphanAttachments: result.orphanAttachments
          })
        }
      })
      .catch((error: unknown) => {
        bootstrapLogger.warn('retention startup janitor failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
  )

  startRetentionJanitor()
  startAuthJanitor()
  startWorkloadReconciler()

  trackStartupTask(
    import('./agent-runtime/cursor-acp/conversation-cursor-reaper')
      .then((module) => {
        module.configureConversationCursorReaper({
          isThreadInflight: (threadId) => ctx.runtimeRegistry.isThreadInflight(threadId)
        })
        module.startConversationCursorReaper()
      })
      .catch((error: unknown) => {
        bootstrapLogger.warn('conversation session reaper startup failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
  )

  trackStartupTask(
    import('./jobs/executor')
      .then((module) => module.initJobExecutor(ctx))
      .catch((error: unknown) => {
        bootstrapLogger.warn('executor startup failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
  )

  return appContext
}

export async function resetAppContextForTests(): Promise<void> {
  stopAuthJanitor()
  stopRetentionJanitor()
  stopWorkloadReconcilerForTests()

  const ctx = appContext
  if (ctx) {
    await waitForPlanningToDrainForTests(ctx)
  }

  await waitForStartupTasksForTests()

  const { stopConversationCursorReaperForTests } =
    await import('./agent-runtime/cursor-acp/conversation-cursor-reaper')
  stopConversationCursorReaperForTests()

  if (appContext) {
    await Promise.allSettled([runRetentionJanitorPass(), runAuthJanitorPass()])
  }

  appContext = null
  startupCoordinator = null
  closeDatabaseForTests()
}
