import { JobEventBus, RuntimeRegistry, SettingsStore, type AppContext } from './context'
import { JobExecutionRuntimeRegistry } from './context/job-execution-runtime'
import { createDatabase, closeDatabaseForTests } from './db'
import {
  reconcileOrphanRunningJobsOnStartupOnce,
  reconcileOrphanPlanningSessionsOnStartupOnce
} from './jobs/reconcile'
import { bindStartupWorkloadGate } from './jobs/workload-slot'
import { reconcileOnStartupOnce } from './conversation/service'
import { pruneOrphanRuntimeTrees } from './runtime/cleanup'
import { runRetentionJanitorPass, startRetentionJanitor, stopRetentionJanitor } from './retention'
import { getOrCreateAuthSecret } from './auth/secret'
import { startAuthJanitor, stopAuthJanitor, runAuthJanitorPass } from './auth/janitor'

export type { AppContext } from './context'

export type AppMode = 'desktop' | 'server'

export interface BootstrapOptions {
  dataDir: string
  mode?: AppMode
}

let appContext: AppContext | null = null
const startupTasks = new Set<Promise<unknown>>()

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
    console.warn('[tests] reset while planning runtime is still active')
  }
}

export function getAppContext(): AppContext {
  if (!appContext) {
    throw new Error('Runtime not bootstrapped')
  }
  return appContext
}

export function bootstrapRuntime(options: BootstrapOptions): AppContext {
  if (appContext) {
    return appContext
  }

  const db = createDatabase(options.dataDir)
  const mode = options.mode ?? 'desktop'

  const settings = new SettingsStore(options.dataDir)
  const authSecret = getOrCreateAuthSecret(settings)

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
    executionRuntime: new JobExecutionRuntimeRegistry()
  }
  process.env.CODETASK_DATA_DIR = options.dataDir

  const ctx = appContext
  const startupReconcile = trackStartupTask(
    reconcileOrphanRunningJobsOnStartupOnce()
      .then(() => reconcileOrphanPlanningSessionsOnStartupOnce())
      .catch((error) => {
        console.warn('[jobs] startup reconcile failed', error)
      })
  )

  bindStartupWorkloadGate(startupReconcile)
  trackStartupTask(
    reconcileOnStartupOnce().catch((error) => {
      console.warn('[conversation] startup reconcile failed', error)
    })
  )
  trackStartupTask(
    pruneOrphanRuntimeTrees(options.dataDir, db)
      .then((result) => {
        if (result.removedPaths.length > 0) {
          console.info('[runtime] pruned orphan runtime trees', result.removedPaths.length)
        }
      })
      .catch((error) => {
        console.warn('[runtime] startup prune failed', error)
      })
  )

  trackStartupTask(
    runRetentionJanitorPass()
      .then((result) => {
        if (
          result.expiredArtifacts > 0 ||
          result.orphanAttachments > 0 ||
          result.staleRuntimes > 0 ||
          result.orphanJobArtifacts > 0 ||
          result.orphanDesignArtifacts > 0 ||
          result.staleAttachmentDirs > 0 ||
          result.orphanRuntimeTrees > 0 ||
          result.sqliteMaintenance.ran
        ) {
          console.info('[retention] startup janitor pass', result)
        }
      })
      .catch((error) => {
        console.warn('[retention] startup janitor failed', error)
      })
  )

  startRetentionJanitor()
  startAuthJanitor()

  trackStartupTask(
    import('./agent-runtime/cursor-acp/conversation-cursor-reaper')
      .then((module) => {
        module.configureConversationCursorReaper({
          isThreadInflight: (threadId) => ctx.runtimeRegistry.isThreadInflight(threadId)
        })
        module.startConversationCursorReaper()
      })
      .catch((error) => {
        console.warn('[cursor-acp] conversation session reaper startup failed', error)
      })
  )

  trackStartupTask(
    import('./jobs/executor')
      .then((module) => module.initJobExecutor(ctx))
      .catch((error) => {
        console.warn('[jobs] executor startup failed', error)
      })
  )

  return appContext
}

export async function resetAppContextForTests(): Promise<void> {
  stopAuthJanitor()
  stopRetentionJanitor()

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
  closeDatabaseForTests()
}
