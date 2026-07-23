import type { SupportedCoreCode } from '../../shared/providers/codes'
import type { ProviderInstallation } from '../../shared/providers/installation'
import type { ProviderSettings } from '../../shared/providers/settings'

export type { SupportedCoreCode }

/** Where the resolved CLI binary came from. */
export type ExecutableSource = 'app-config' | 'env' | 'install-dir' | 'path'

export interface ResolvedExecutable {
  /** Bare command name preferred for display / probe labels. */
  command: string
  /** Path or command name suitable for spawn / which. */
  executable: string
  source: ExecutableSource
}

export type EnvVarSource = 'host' | 'provider-overlay' | 'sandbox' | 'task'

export interface LaunchEnvVarSummary {
  name: string
  source: EnvVarSource
  present: boolean
}

/** Redacted launch diagnostics: names and sources only, never values. */
export interface LaunchSummary {
  provider: SupportedCoreCode
  executable: string
  executableSource: ExecutableSource
  cwd: string
  envVars: readonly LaunchEnvVarSummary[]
}

export interface LaunchSpec {
  installationId: string
  executable: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  redactedSummary: LaunchSummary
}

export interface LaunchContext {
  cwd: string
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  providerOverlay?: Record<string, string>
  taskOverlay?: Record<string, string>
  sandboxOverlay?: Record<string, string>
  args?: readonly string[]
  providerSettings?: ProviderSettings
  installation?: ProviderInstallation
}
