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
}

export interface ProviderAuthPreflightResult {
  ok: boolean
  message: string
  loggedIn?: boolean
}
