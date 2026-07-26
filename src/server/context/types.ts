import type { KernelSqliteDatabase } from '../adapters/sqlite'
import type { SecureAuthModule } from '../composition/auth'

export interface SecurityContext {
  readonly mode: 'desktop' | 'server'
  readonly authSecret: string
  readonly auth: SecureAuthModule
}

export interface AppContext {
  readonly dataDir: string
  readonly kernelDb: KernelSqliteDatabase
  readonly security: SecurityContext
  readonly storage?: {
    readonly bootstrapRoot: string
    readonly source: string
    readonly managed: boolean
  }
}
