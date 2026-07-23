import { processHostEnvironmentSource } from '../host-environment'

export type SandboxReadRootMode = 'directory_only'

export interface SandboxReadCapabilities {
  platform: NodeJS.Platform

  nativeSandboxAvailable: boolean

  readRootMode: SandboxReadRootMode

  singleFileAllowlist: boolean
}

let cached: SandboxReadCapabilities | null = null

export function detectSandboxReadCapabilities(): SandboxReadCapabilities {
  if (cached) return cached

  // Reference projection is shared by direct Planner/create-task turns. It must
  // never probe or load the native sandbox; execution preflight owns that check.
  const nativeSandboxAvailable = false
  const hostEnv = processHostEnvironmentSource.snapshot()
  const singleFileAllowlist =
    hostEnv.CODETASK_SANDBOX_SINGLE_FILE_ALLOWLIST === '1' ||
    hostEnv.CODETASK_SANDBOX_SINGLE_FILE_ALLOWLIST === 'true'

  cached = {
    platform: process.platform,
    nativeSandboxAvailable,
    readRootMode: 'directory_only',
    singleFileAllowlist
  }
  return cached
}

export function resetSandboxReadCapabilitiesCache(): void {
  cached = null
}

export function setSandboxReadCapabilitiesForTest(caps: SandboxReadCapabilities): void {
  cached = caps
}
