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
import type { AppContext } from './context'
import { dataPaths } from './data-paths'

export type { AppContext } from './context'

export type AppMode = 'desktop' | 'server'

export interface BootstrapOptions {
  readonly dataDir: string
  readonly mode?: AppMode
  readonly authSecretPath?: string
  readonly authSecret?: string
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
    const context: AppContext = {
      dataDir: options.dataDir,
      kernelDb,
      security: { mode, authSecret, auth },
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
      },
      async shutdown(): Promise<void> {
        if (closed) return
        closed = true
        try {
          auth.dispose()
        } finally {
          kernelDb.close()
        }
      }
    })
  } catch (error) {
    kernelDb.close()
    throw error
  }
}
