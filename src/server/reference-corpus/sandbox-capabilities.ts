import { createRequire } from 'node:module'

export type SandboxReadRootMode = 'directory_only'

export interface SandboxReadCapabilities {
  platform: NodeJS.Platform

  nativeSandboxAvailable: boolean

  readRootMode: SandboxReadRootMode

  singleFileAllowlist: boolean
}

let cached: SandboxReadCapabilities | null = null

const nodeRequire = createRequire(import.meta.url)

function readSingleFileAllowlistFromAppConfig(): boolean {
  // Deferred import avoids sandbox-capabilities → bootstrap → … → paths → cycle.
  // getAppConfig() returns DEFAULT_APP_CONFIG (singleFileAllowlist: false) when not bootstrapped.
  const { getAppConfig } = nodeRequire('../bootstrap.ts') as typeof import('../bootstrap')
  return getAppConfig().sandbox.singleFileAllowlist
}

export function detectSandboxReadCapabilities(): SandboxReadCapabilities {
  if (cached) return cached

  // Reference projection is shared by direct Planner/create-task turns. It must
  // never probe or load the native sandbox; execution preflight owns that check.
  const nativeSandboxAvailable = false
  const singleFileAllowlist = readSingleFileAllowlistFromAppConfig()

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
