import type { AppDatabase } from '../db'
import type { JobExecutionRuntimeRegistry } from './job-execution-runtime'
import type { RuntimeRegistry } from './runtime-registry'
import type { SettingsStore } from './settings-store'
import type { ApplicationRuntime } from '../application/application-runtime'
import type { AppConfig } from '../config/app-config'
import type { ProviderRegistry } from '../providers/registry'
import type { ProviderRuntimeManager } from '../providers/lifecycle'
import type { SecureAuthService } from '../auth/service'
import type { RealtimeModule } from '@codetask/server-core'

export interface SecurityContext {
  mode: 'desktop' | 'server'
  authSecret: string
  auth: SecureAuthService
  setupToken?: string
}

export interface AppContext {
  config: AppConfig
  dataDir: string
  db: AppDatabase
  settings: SettingsStore
  /** Unified durable + ephemeral browser realtime gateway (06). */
  realtime: RealtimeModule
  runtimeRegistry: RuntimeRegistry
  executionRuntime: JobExecutionRuntimeRegistry
  providerRegistry: ProviderRegistry
  providerRuntimeManager: ProviderRuntimeManager
  security: SecurityContext
  bootId: string
  applicationRuntime: ApplicationRuntime | null
  storage?: {
    source: string
  }
}
