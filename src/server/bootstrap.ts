import { randomUUID } from 'crypto'
import { JobEventBus, RuntimeRegistry, SettingsStore, type AppContext } from './context'
import { JobExecutionRuntimeRegistry } from './context/job-execution-runtime'
import { createDatabase, closeDatabaseForTests } from './db'
import { runRetentionJanitorPass, startRetentionJanitor, stopRetentionJanitor } from './retention'
import { getOrCreateAuthSecret } from './auth/secret'
import { startAuthJanitor, stopAuthJanitor, runAuthJanitorPass } from './auth/janitor'
import { SafeLoggerImpl } from './application/safe-logger'
import { LEGACY_RESUME_RUNNING_DISABLED } from './application/legacy-resume-running-disabled'
import { StartupError } from './application/startup-error'
import { readSchemaGeneration } from './application/cutover-state'
import {
  startApplicationRuntime,
  shutdownApplicationRuntime,
  resetApplicationRuntimeForTests
} from './application/application-runtime'
import { getApplicationStartup } from './application/application-runtime'
import type { StartupCoordinator } from './application/startup-coordinator'

export type { AppContext } from './context'

export type AppMode = 'desktop' | 'server'

export interface BootstrapOptions {
  dataDir: string
  mode?: AppMode
}

let appContext: AppContext | null = null
const bootstrapLogger = new SafeLoggerImpl()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  if (!appContext?.applicationRuntime) {
    return null
  }
  return getApplicationStartup(appContext)
}

export function bootstrapRuntime(options: BootstrapOptions): AppContext {
  if (appContext) {
    return appContext
  }

  void LEGACY_RESUME_RUNNING_DISABLED

  const db = createDatabase(options.dataDir)
  try {
    const schemaRead = readSchemaGeneration(db)

    // FIX-PLAN F1 / R6: fail closed before publishing global context or starting janitors.
    if (schemaRead === 'v3_authoritative') {
      throw new StartupError('control_plane.v3_not_release_ready')
    }

    const mode = options.mode ?? 'desktop'
    const settings = new SettingsStore(options.dataDir)
    const authSecret = getOrCreateAuthSecret(options.dataDir)
    const bootId = randomUUID()

    const nextContext: AppContext = {
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
      bootId,
      applicationRuntime: null
    }
    process.env.CODETASK_DATA_DIR = options.dataDir

    appContext = nextContext

    startRetentionJanitor()
    startAuthJanitor()

    void runRetentionJanitorPass()
      .then((result) => {
        if (
          result.expiredArtifacts > 0 ||
          result.orphanAttachments > 0 ||
          result.staleRuntimes > 0 ||
          result.completedTaskRuntimes > 0 ||
          result.orphanDesignArtifacts > 0 ||
          result.staleAttachmentDirs > 0 ||
          result.orphanRuntimeTrees > 0 ||
          result.sqliteMaintenance.ran
        ) {
          bootstrapLogger.info('retention startup janitor pass', {
            expiredArtifacts: result.expiredArtifacts,
            orphanAttachments: result.orphanAttachments,
            completedTaskRuntimes: result.completedTaskRuntimes
          })
        }
      })
      .catch((error: unknown) => {
        bootstrapLogger.warn('retention startup janitor failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      })

    return appContext
  } catch (error) {
    closeDatabaseForTests()
    throw error
  }
}

/** Fail-closed readiness barrier used before HTTP bind/listen. */
export async function ensureRuntimeReady(ctx: AppContext = getAppContext()): Promise<void> {
  await startApplicationRuntime(ctx)
}

export async function shutdownRuntime(reason: 'app_shutdown' | 'user_quit' | 'signal' = 'app_shutdown'): Promise<void> {
  const ctx = appContext
  if (!ctx) return
  await shutdownApplicationRuntime(ctx, reason)
}

export async function resetAppContextForTests(): Promise<void> {
  stopAuthJanitor()
  stopRetentionJanitor()

  const ctx = appContext
  if (ctx) {
    await waitForPlanningToDrainForTests(ctx)
    await resetApplicationRuntimeForTests(ctx)
  }

  const { stopConversationCursorReaperForTests } =
    await import('./agent-runtime/cursor-acp/conversation-cursor-reaper')
  stopConversationCursorReaperForTests()

  if (appContext) {
    await Promise.allSettled([runRetentionJanitorPass(), runAuthJanitorPass()])
  }

  appContext = null
  closeDatabaseForTests()
}
