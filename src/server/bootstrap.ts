import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { getOrCreateAuthSecret } from './auth/secret'
import {
  migrateLegacyAuthIfNeeded,
  openKernelDatabase,
  validateKernelDatabase,
  type KernelSqliteDatabase
} from './adapters/sqlite'
import { createSecureAuthModule } from './composition/auth'
import { createConversationModule } from './composition/conversation'
import { createDraftModule } from './composition/draft'
import { createJobModule } from './composition/job'
import type { JobItemExecutor } from './composition/job'
import type { AppContext } from './context'
import { dataPaths } from './data-paths'
import { processHostEnvironmentSource } from './host-environment'

export type { AppContext } from './context'

export type AppMode = 'desktop' | 'server'

export interface BootstrapOptions {
  readonly dataDir: string
  readonly mode?: AppMode
  readonly authSecretPath?: string
  readonly authSecret?: string
  /** Deterministic executor injection for contract/E2E tests; production omits it. */
  readonly jobExecutor?: JobItemExecutor
  readonly storage?: {
    readonly bootstrapRoot: string
    readonly source: string
    readonly managed: boolean
  }
}

export interface ApplicationRuntime {
  readonly context: AppContext
  ensureReady(): Promise<void>
  shutdown(): Promise<void>
}

function migrateLegacyAccountIfPresent(
  dataDir: string,
  kernelDatabase: KernelSqliteDatabase
): void {
  const legacyPath = dataPaths(dataDir).legacyDbFile
  if (!existsSync(legacyPath)) return

  const legacyDatabase = new Database(legacyPath, {
    readonly: true,
    fileMustExist: true
  })
  try {
    migrateLegacyAuthIfNeeded({ legacyDatabase, kernelDatabase })
  } finally {
    legacyDatabase.close()
  }
}

export function createRuntime(options: BootstrapOptions): ApplicationRuntime {
  const mode = options.mode ?? 'desktop'
  const authSecret =
    options.authSecret ??
    (options.authSecretPath
      ? getOrCreateAuthSecret(options.authSecretPath)
      : randomBytes(32).toString('hex'))
  const kernelDb = openKernelDatabase({ filename: dataPaths(options.dataDir).authDbFile })

  try {
    migrateLegacyAccountIfPresent(options.dataDir, kernelDb)
    const auth = createSecureAuthModule({
      database: kernelDb,
      authSecret,
      mode
    })
    const draft = createDraftModule({
      database: kernelDb,
      runtimeRoot: dataPaths(options.dataDir).draftRuntime,
      draftAssetsRoot: dataPaths(options.dataDir).draftAssets,
      jobIntakeAssetsRoot: dataPaths(options.dataDir).jobIntakeAssets,
      hostEnvironment: processHostEnvironmentSource.snapshot()
    })
    const job = createJobModule({
      database: kernelDb,
      runtimeRoot: dataPaths(options.dataDir).jobRuntime,
      jobAssetsRoot: dataPaths(options.dataDir).jobIntakeAssets,
      hostEnvironment: processHostEnvironmentSource.snapshot(),
      executor: options.jobExecutor
    })
    const conversation = createConversationModule({
      database: kernelDb,
      runtimeRoot: dataPaths(options.dataDir).conversationRuntime,
      hostEnvironment: processHostEnvironmentSource.snapshot(),
      workspaceIsWriteLocked: (workspaceId) =>
        job.service.workspaceHasActiveLease(workspaceId)
    })
    const context: AppContext = {
      dataDir: options.dataDir,
      kernelDb,
      security: { mode, authSecret, auth },
      conversation,
      draft,
      job,
      ...(options.storage ? { storage: options.storage } : {})
    }
    auth.service.cleanup()
    auth.startCleanup()

    let closed = false
    return Object.freeze({
      context,
      async ensureReady(): Promise<void> {
        if (closed) throw new Error('Runtime is closed')
        const validation = validateKernelDatabase(kernelDb.client)
        if (!validation.ok) {
          throw new Error(`auth_database.invalid:${validation.integrity}`)
        }
        await job.start()
      },
      async shutdown(): Promise<void> {
        if (closed) return
        closed = true
        try {
          await job.shutdown()
          await Promise.all([conversation.shutdown(), draft.shutdown()])
        } finally {
          try {
            auth.dispose()
          } finally {
            kernelDb.close()
          }
        }
      }
    })
  } catch (error) {
    kernelDb.close()
    throw error
  }
}
