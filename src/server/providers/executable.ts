import { createRequire } from 'node:module'
import type { ProviderInstallationSource } from '../../shared/providers/installation'
import type { SupportedCoreCode } from '../../shared/providers/codes'
import { DEFAULT_PROVIDERS_CONFIG, type ProviderSettings } from '../../shared/providers/settings'
import {
  providerInstallationResolver,
  type ProviderDiscoveryContext,
  type ProviderInstallationResolver
} from './installation'
import { processHostEnvironmentSource } from '../host-environment'

const nodeRequire = createRequire(import.meta.url)

export type ExecutableSource = ProviderInstallationSource

/** Compatibility DTO for callers not yet migrated to ProviderInstallation. */
export interface ResolvedExecutable {
  readonly command: string
  readonly executable: string
  readonly source: ExecutableSource
  readonly installationId: string
  readonly prefixArgs: readonly string[]
}

export interface ResolveProviderExecutableOptions {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly settings?: ProviderSettings | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly installDirs?: readonly string[] | undefined
  readonly resolver?: ProviderInstallationResolver | undefined
}

function isOptions(
  value: Readonly<Record<string, string | undefined>> | ResolveProviderExecutableOptions | undefined
): value is ResolveProviderExecutableOptions {
  return Boolean(
    value &&
    ('env' in value ||
      'settings' in value ||
      'platform' in value ||
      'installDirs' in value ||
      'resolver' in value)
  )
}

function defaultProviderSettings(provider: SupportedCoreCode): ProviderSettings {
  // Deferred import avoids executable → bootstrap → composition → drivers cycles.
  const { getAppConfig } = nodeRequire('../bootstrap.ts') as typeof import('../bootstrap')
  return getAppConfig().providers[provider] ?? DEFAULT_PROVIDERS_CONFIG[provider]
}

export function resolveProviderExecutable(
  provider: SupportedCoreCode,
  envOrOptions?: Readonly<Record<string, string | undefined>> | ResolveProviderExecutableOptions
): ResolvedExecutable | null {
  const options = isOptions(envOrOptions) ? envOrOptions : { env: envOrOptions }
  const installation = (options.resolver ?? providerInstallationResolver).resolve(provider, {
    settings: options.settings ?? defaultProviderSettings(provider),
    hostEnv: options.env ?? processHostEnvironmentSource.snapshot(),
    platform: options.platform,
    installDirs: options.installDirs
  } satisfies ProviderDiscoveryContext)
  if (!installation) return null
  return {
    command: installation.command,
    executable: installation.invocation.executable,
    source: installation.source,
    installationId: installation.id,
    prefixArgs: installation.invocation.prefixArgs
  }
}
