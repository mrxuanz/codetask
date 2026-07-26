import type { ProviderProfileCode } from '../types.ts'

export type PathResolverPlatform = 'darwin' | 'linux' | 'win32'

export interface HostRoots {
  readonly home: string
  readonly appData: string
  readonly localAppData: string
}

/**
 * Precise host identity/config paths for one Provider.
 * Never includes the whole HOME / user Profile as a capability root.
 */
export interface ProviderIdentityPaths {
  readonly provider: ProviderProfileCode
  readonly credentialFiles: readonly string[]
  readonly credentialDirs: readonly string[]
  readonly configDirs: readonly string[]
}

export type HostEnv = Readonly<Record<string, string | undefined>>

export interface PlatformPathResolver {
  readonly platform: PathResolverPlatform
  resolveHostRoots(env: HostEnv): HostRoots
  resolveIdentityPaths(provider: ProviderProfileCode, roots: HostRoots, env?: HostEnv): ProviderIdentityPaths
  /**
   * Reject whole HOME, disk roots, and unexpanded variables.
   * Throws when `candidate` is not a precise identity/config path under roots.
   */
  assertPrecisePath(candidate: string, roots: HostRoots): void
}

export class PathResolverError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'PathResolverError'
    this.code = code
  }
}
