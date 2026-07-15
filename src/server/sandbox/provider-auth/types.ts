import type { SupportedCoreCode } from '../../conversation/cores'

export type ProviderAuthMode = 'runtime-copy' | 'host-identity'

export interface ProviderAuthDiagnostics {
  provider: SupportedCoreCode
  mode: ProviderAuthMode
  authMaterialPresent: boolean
  hostAuthPath?: string
  runtimeAuthPath?: string
  warnings: string[]
}

export interface ProviderAuthPrepared {
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
