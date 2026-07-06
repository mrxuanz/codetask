import { tryLoadSandboxNative } from '../sandbox/native'

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

  const nativeSandboxAvailable = tryLoadSandboxNative() !== null
  const singleFileAllowlist =
    process.env.CODETASK_SANDBOX_SINGLE_FILE_ALLOWLIST === '1' ||
    process.env.CODETASK_SANDBOX_SINGLE_FILE_ALLOWLIST === 'true'

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
