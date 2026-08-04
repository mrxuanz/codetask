import type { SupportedCoreCode } from './codes'

export type ProviderInstallationSource = 'app-config' | 'install-dir' | 'path'

export interface CommandInvocation {
  readonly executable: string
  readonly prefixArgs: readonly string[]
}

export interface ProviderInstallation {
  readonly id: string
  readonly provider: SupportedCoreCode
  readonly command: string
  readonly source: ProviderInstallationSource
  readonly invocation: CommandInvocation
  /**
   * Executable entry selected from PATH or app configuration.
   * This may be a shim or symlink and must be preserved for process launch.
   */
  readonly resolvedPath: string
  /**
   * Filesystem identity behind `resolvedPath`.
   * Diagnostic/sandbox metadata only — never use this path as argv[0].
   */
  readonly canonicalPath: string
}

export type ProviderPreflightErrorCode =
  | 'disabled'
  | 'not-installed'
  | 'not-authenticated'
  | 'config-invalid'
  | 'probe-failed'

export interface ProviderPreflightResult {
  readonly ok: boolean
  readonly provider: SupportedCoreCode
  readonly errorCode?: ProviderPreflightErrorCode | undefined
  readonly message?: string | undefined
  readonly userAction?: string | undefined
}
