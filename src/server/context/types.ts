import type { KernelSqliteDatabase } from '../adapters/sqlite'
import type { SecureAuthModule } from '../composition/auth'
import type { ConversationModule } from '../composition/conversation'
import type { DraftModule } from '../composition/draft'
import type { JobModule } from '../composition/job'

export interface SecurityContext {
  readonly mode: 'desktop' | 'server'
  readonly authSecret: string
  readonly auth: SecureAuthModule
}

export interface AppContext {
  readonly dataDir: string
  readonly kernelDb: KernelSqliteDatabase
  readonly security: SecurityContext
  readonly conversation: ConversationModule
  readonly draft: DraftModule
  readonly job: JobModule
  readonly storage?: {
    readonly bootstrapRoot: string
    readonly source: string
    readonly managed: boolean
  }
}
