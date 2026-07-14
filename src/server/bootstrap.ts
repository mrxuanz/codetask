import { randomUUID } from 'crypto'
import { JobEventBus, RuntimeRegistry, SettingsStore, type AppContext } from './context'
import { JobExecutionRuntimeRegistry } from './context/job-execution-runtime'
import { createDatabase, closeDatabaseForTests } from './db'
import { runRetentionJanitorPass, startRetentionJanitor, stopRetentionJanitor } from './retention'
import { getOrCreateAuthSecret } from './auth/secret'
import { startAuthJanitor, stopAuthJanitor, runAuthJanitorPass } from './auth/janitor'
import { SafeLoggerImpl } from './application/safe-logger'
import { LEGACY_RESUME_RUNNING_DISABLED } from './application/legacy-resume-running-disabled'
import { readSchemaGeneration } from './application/cutover-state'
import {
  createV3ApplicationRuntime,
  startApplicationRuntime,
  shutdownApplicationRuntime,
  resetApplicationRuntimeForTests
} from './application/application-runtime'
import { getApplicationStartup } from './application/application-runtime'

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

export function getStartupCoordinator() {
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
  const schemaRead = readSchemaGeneration(db)
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
    bootId,
    applicationRuntime: null
  }
  process.env.CODETASK_DATA_DIR = options.dataDir

  appContext.applicationRuntime =
    schemaRead === 'v3_authoritative' ? createV3ApplicationRuntime(appContext) : null

  startRetentionJanitor()
  startAuthJanitor()

  if (schemaRead !== 'v3_authoritative') {
    void runRetentionJanitorPass()
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
  }

  return appContext
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
