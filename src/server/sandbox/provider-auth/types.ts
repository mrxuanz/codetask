import type { SupportedCoreCode } from '../../conversation/cores'
import type { ProviderAuthMode } from '../../../shared/providers/capabilities'

export type { ProviderAuthMode }

export interface ProviderAuthDiagnostics {
  provider: SupportedCoreCode
  mode: ProviderAuthMode
  authMaterialPresent: boolean
  hostAuthPath?: string
  runtimeAuthPath?: string
  warnings: string[]
}

/**
 * Log-safe auth summary: presence and mode only — never env values or token text.
 * Paths are omitted so home directories / filenames cannot leak into debug streams.
 */
export interface ProviderAuthLogDto {
  provider: SupportedCoreCode
  mode: ProviderAuthMode
  authMaterialPresent: boolean
  warningCount: number
}

export function toProviderAuthLogDto(diagnostics: ProviderAuthDiagnostics): ProviderAuthLogDto {
  return {
    provider: diagnostics.provider,
    mode: diagnostics.mode,
    authMaterialPresent: diagnostics.authMaterialPresent,
    warningCount: diagnostics.warnings.length
  }
}

export interface ProviderAuthPrepared {
  mode: ProviderAuthMode
  runtimeRoot: string
  envPatch: Record<string, string>
  readRoots: string[]

  writeRoots?: string[]
  cleanupPlan: () => void
  diagnostics: ProviderAuthDiagnostics
  filesystemProfile: ProviderFilesystemProfile
}

export interface CredentialSnapshotSpec {
  relativePath: string
  required: boolean
}

export interface ProviderFilesystemProfile {
  provider: SupportedCoreCode
  hostReadRoots: string[]
  hostWriteRoots: string[]
  runtimeEnv: Record<string, string>
  credentialSnapshots: CredentialSnapshotSpec[]
  scrubPatterns: string[]
}

export interface ProviderAuthPreflightResult {
  ok: boolean
  message: string
  loggedIn?: boolean
}
