import type { AppDatabase } from '../db'
import type { JobEventBus } from './event-bus'
import type { JobExecutionRuntimeRegistry } from './job-execution-runtime'
import type { RuntimeRegistry } from './runtime-registry'
import type { SettingsStore } from './settings-store'

export interface SecurityContext {
  mode: 'desktop' | 'server'
  authSecret: string
  setupToken?: string
}

export interface AppContext {
  dataDir: string
  db: AppDatabase
  settings: SettingsStore
  eventBus: JobEventBus
  runtimeRegistry: RuntimeRegistry
  executionRuntime: JobExecutionRuntimeRegistry
  security: SecurityContext
  bootId: string
}
