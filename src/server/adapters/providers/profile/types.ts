/**
 * Versioned ProviderRuntimeProfile — Adapter-owned runtime requirements.
 *
 * Frozen contract (重构.md §8.5 / INVARIANTS §runtime):
 * - No credential materialize / credential copy / snapshot / host sync in NEW adapters.
 * - Host identity via env, OS keyring, or precise path allowlist — never whole HOME.
 * - Paths must be absolute, resolver-produced; Provider cannot append permissions at runtime.
 */

export const PROVIDER_RUNTIME_PROFILE_VERSION = 1 as const

/** Provider code used by Adapter profiles (includes Fake for new-core tests). */
export type ProviderProfileCode = string

export type PathAccess = 'read' | 'read-write'

export type PathPurpose = 'credential' | 'config' | 'toolchain' | 'mcp' | 'provider-state'

export interface PathCapability {
  readonly path: string
  readonly access: PathAccess
  readonly purpose: PathPurpose
  readonly required: boolean
}

export type InstancePathKind =
  | 'home'
  | 'config'
  | 'data'
  | 'cache'
  | 'state'
  | 'tmp'
  | 'log'
  | 'ipc'

export type CredentialAccessMethod =
  | { readonly type: 'environment'; readonly names: readonly string[] }
  | { readonly type: 'os-keyring'; readonly service: string }
  | { readonly type: 'host-path'; readonly paths: readonly PathCapability[] }

export interface ProviderNetworkProfile {
  readonly allowInternetEgress: boolean
  /** Approved localhost MCP endpoints / sockets only — never open whole loopback. */
  readonly localhostAllowlist: readonly string[]
  readonly allowListen: boolean
}

export interface ProviderProcessProfile {
  readonly maxProcesses?: number | undefined
  readonly memoryLimitMb?: number | undefined
}

export interface ProviderRuntimeFilesystem {
  readonly hostRead: readonly PathCapability[]
  readonly hostWrite: readonly PathCapability[]
  readonly instanceReadWrite: readonly InstancePathKind[]
}

/**
 * Versioned runtime requirements declared by a Provider Adapter.
 * Compiled by Runtime Policy Compiler; child process cannot widen this.
 */
export interface ProviderRuntimeProfile {
  readonly provider: ProviderProfileCode
  readonly version: number
  readonly environment: Readonly<Record<string, string>>
  readonly filesystem: ProviderRuntimeFilesystem
  readonly credentials: readonly CredentialAccessMethod[]
  readonly network: ProviderNetworkProfile
  readonly process: ProviderProcessProfile
}

/** Auth modes allowed on the NEW adapter path — copy is intentionally absent. */
export type NewPathAuthMode = 'host-identity' | 'environment' | 'os-keyring'

export function isNewPathAuthMode(value: string): value is NewPathAuthMode {
  return value === 'host-identity' || value === 'environment' || value === 'os-keyring'
}
