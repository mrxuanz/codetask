import { randomUUID } from 'crypto'
import { JobEventBus, RuntimeRegistry, SettingsStore, type AppContext } from './context'
import { JobExecutionRuntimeRegistry } from './context/job-execution-runtime'
import { createDatabase, closeDatabaseForTests } from './db'
import { runRetentionJanitorPass, startRetentionJanitor, stopRetentionJanitor } from './retention'
import { loadDatabaseAuthSecret } from './auth/secret'
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
import {
  startArtifactExpiryScheduler,
  stopArtifactExpiryScheduler
} from './retention/expiry-scheduler'
import {
  createAppConfig,
  DEFAULT_APP_CONFIG,
  type AppConfig,
  type AppConfigOverrides
} from './config/app-config'
import {
  mergeProvidersConfigOverrides,
  parseProvidersConfigOverrides
} from '../shared/providers/settings'
import { createProviderRegistry } from './providers/composition'
import { ProviderRuntimeManager } from './providers/lifecycle'
import { SecureAuthService } from './auth/service'
import { configureRuntimeMode, resetRuntimeMode } from './runtime-mode'
import {
  configureRuntimeFeatures,
  resetRuntimeFeatures
} from './config/runtime-features'
import {
  configureShellChildEnvironment,
  resetShellChildEnvironment
} from './shell-child-environment'

export type { AppContext } from './context'

export type AppMode = 'desktop' | 'server'

export interface BootstrapOptions {
  dataDir: string
  mode?: AppMode
  config?: AppConfigOverrides
  shellChildEnvironment?: Record<string, string>
  storage?: {
    source: string
  }
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

export function getAppConfig(): AppConfig {
  return appContext?.config ?? DEFAULT_APP_CONFIG
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
    configureRuntimeMode(mode)
    configureShellChildEnvironment(options.shellChildEnvironment)
    const settings = new SettingsStore(options.dataDir, db)
    const authSecret = loadDatabaseAuthSecret(db)
    const bootId = randomUUID()
    const persistedProviderValue = settings.readNamespace('provider_runtime').value
    const persistedProviderOverrides = parseProvidersConfigOverrides(
      persistedProviderValue?.providers ?? persistedProviderValue ?? {}
    )
    const config = createAppConfig({
      ...options.config,
      providers: mergeProvidersConfigOverrides(
        persistedProviderOverrides,
        options.config?.providers
      )
    })
    configureRuntimeFeatures({
      sandbox: config.sandbox,
      debug: config.debug
    })

    const nextContext: AppContext = {
      config,
      dataDir: options.dataDir,
      db,
      settings,
      security: {
        mode,
        authSecret,
        auth: new SecureAuthService(db, authSecret)
      },
      eventBus: new JobEventBus(),
      runtimeRegistry: new RuntimeRegistry(),
      executionRuntime: new JobExecutionRuntimeRegistry(),
      providerRegistry: createProviderRegistry(config.providers),
      providerRuntimeManager: new ProviderRuntimeManager(),
      bootId,
      applicationRuntime: null,
      ...(options.storage ? { storage: options.storage } : {})
    }
    appContext = nextContext

    startRetentionJanitor()
    startArtifactExpiryScheduler(nextContext)
    startAuthJanitor()

    void runRetentionJanitorPass()
      .then((result) => {
        if (
          result.expiredArtifacts > 0 ||
          result.orphanAttachments > 0 ||
          result.staleRuntimes > 0 ||
          result.completedTaskRuntimes > 0 ||
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
    resetRuntimeMode()
    resetRuntimeFeatures()
    resetShellChildEnvironment()
    closeDatabaseForTests()
    throw error
  }
}

/** Fail-closed readiness barrier used before HTTP bind/listen. */
export async function ensureRuntimeReady(ctx: AppContext = getAppContext()): Promise<void> {
  await startApplicationRuntime(ctx)
}

export async function shutdownRuntime(
  reason: 'app_shutdown' | 'user_quit' | 'signal' = 'app_shutdown'
): Promise<void> {
  const ctx = appContext
  if (!ctx) return
  // Reject new Provider turns first, let the application drain active owners,
  // then close any remaining turn handles and shared protocol transports.
  ctx.providerRuntimeManager.beginDrain()
  await shutdownApplicationRuntime(ctx, reason)
  await ctx.providerRuntimeManager.closeAll().catch((error: unknown) => {
    bootstrapLogger.warn('provider runtime shutdown failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  })
}

export async function resetAppContextForTests(): Promise<void> {
  stopAuthJanitor()
  stopRetentionJanitor()
  stopArtifactExpiryScheduler()

  const ctx = appContext
  if (ctx) {
    await ctx.providerRuntimeManager.closeAll().catch(() => undefined)
    await waitForPlanningToDrainForTests(ctx)
    await resetApplicationRuntimeForTests(ctx)
  }

  const { stopConversationCursorReaperForTests } =
    await import('./agent-runtime/cursor-acp/conversation-cursor-reaper')
  stopConversationCursorReaperForTests()

  if (appContext) {
    await Promise.allSettled([runRetentionJanitorPass(), runAuthJanitorPass()])
    appContext.settings.close()
  }

  appContext = null
  resetRuntimeMode()
  resetRuntimeFeatures()
  resetShellChildEnvironment()
  closeDatabaseForTests()
}
