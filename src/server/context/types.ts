import type { AppDatabase } from '../db'
import type { JobEventBus } from './event-bus'
import type { JobExecutionRuntimeRegistry } from './job-execution-runtime'
import type { RuntimeRegistry } from './runtime-registry'
import type { SettingsStore } from './settings-store'
import type { ApplicationRuntime } from '../application/application-runtime'
import type { McpSecretProvider } from '../settings/mcp-secret-provider'
import type { AppConfig } from '../config/app-config'
import type { ProviderRegistry } from '../providers/registry'
import type { ProviderRuntimeManager } from '../providers/lifecycle'

export interface SecurityContext {
  mode: 'desktop' | 'server'
  authSecret: string
  mcpSecrets: McpSecretProvider
  setupToken?: string
}

export interface AppContext {
  config: AppConfig
  dataDir: string
  db: AppDatabase
  settings: SettingsStore
  eventBus: JobEventBus
  runtimeRegistry: RuntimeRegistry
  executionRuntime: JobExecutionRuntimeRegistry
  providerRegistry: ProviderRegistry
  providerRuntimeManager: ProviderRuntimeManager
  security: SecurityContext
  bootId: string
  applicationRuntime: ApplicationRuntime | null
  storage?: {
    bootstrapRoot: string
    source: string
    managed: boolean
  }
}
