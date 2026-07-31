import type { SupportedCoreCode } from '../../conversation/cores'
import type { ProviderAuthMode } from '../../../shared/providers/capabilities'

export type { ProviderAuthMode }

export const PROVIDER_RUNTIME_PROFILE_SCHEMA_VERSION = 1 as const

export type ProviderRuntimePlatform = 'darwin' | 'linux' | 'win32'
export type ProviderPathGrantAccess = 'read' | 'read-write'
export type ProviderPathGrantKind =
  | 'identity'
  | 'configuration'
  | 'platform-credential-store'
  | 'executable'
  | 'runtime-compatibility'

/**
 * A single, auditable host path made visible to a Provider process.
 *
 * Runtime-owned paths are deliberately not represented here: the sandbox
 * already grants the per-instance runtime root read/write access.
 */
export interface ProviderPathGrant {
  readonly path: string
  readonly access: ProviderPathGrantAccess
  readonly kind: ProviderPathGrantKind
  readonly reason: string
}

export interface ProviderRuntimeDiagnostics {
  provider: SupportedCoreCode
  mode: ProviderAuthMode
  authMaterialPresent: boolean
  primaryIdentityPath?: string
  warnings: string[]
}

/**
 * Log-safe runtime summary: presence and mode only — never env values, host
 * paths, grant reasons, or token text.
 * Paths are omitted so home directories / filenames cannot leak into debug streams.
 */
export interface ProviderRuntimeLogDto {
  provider: SupportedCoreCode
  mode: ProviderAuthMode
  authMaterialPresent: boolean
  warningCount: number
  hostReadGrantCount: number
  hostWriteGrantCount: number
}

export interface ProviderRuntimeProfile {
  readonly schemaVersion: typeof PROVIDER_RUNTIME_PROFILE_SCHEMA_VERSION
  readonly provider: SupportedCoreCode
  readonly platform: ProviderRuntimePlatform
  readonly mode: ProviderAuthMode
  readonly runtimeRoot: string
  /** Private instance-owned state root. It is always inside runtimeRoot. */
  readonly stateRoot: string
  readonly environment: Readonly<Record<string, string>>
  readonly hostPathGrants: readonly ProviderPathGrant[]
  readonly diagnostics: ProviderRuntimeDiagnostics
}

export function providerRuntimeReadRoots(profile: ProviderRuntimeProfile): string[] {
  return profile.hostPathGrants.map((grant) => grant.path)
}

export function providerRuntimeWriteRoots(profile: ProviderRuntimeProfile): string[] {
  return profile.hostPathGrants
    .filter((grant) => grant.access === 'read-write')
    .map((grant) => grant.path)
}

export function toProviderRuntimeLogDto(profile: ProviderRuntimeProfile): ProviderRuntimeLogDto {
  const writeGrantCount = profile.hostPathGrants.filter(
    (grant) => grant.access === 'read-write'
  ).length
  return {
    provider: profile.provider,
    mode: profile.mode,
    authMaterialPresent: profile.diagnostics.authMaterialPresent,
    warningCount: profile.diagnostics.warnings.length,
    hostReadGrantCount: profile.hostPathGrants.length,
    hostWriteGrantCount: writeGrantCount
  }
}
