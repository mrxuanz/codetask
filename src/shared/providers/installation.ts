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
  readonly resolvedPath: string
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
