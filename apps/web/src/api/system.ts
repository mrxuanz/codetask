import { api } from './client'
import type { ApiSuccess } from './types'

export type SandboxHealthStatus = 'ready' | 'degraded' | 'unavailable' | 'disabled'

export interface SandboxHealthCheck {
  ok: boolean
  code?: string
  message?: string
  requirement?: string
}

export interface SandboxHealthReport {
  status: SandboxHealthStatus
  platform: string
  outerSandboxEnabled: boolean
  backend?: string
  native: SandboxHealthCheck
  platformRuntime?: SandboxHealthCheck
  windowsSetup?: SandboxHealthCheck
  supervisor?: SandboxHealthCheck
  helperVersion?: string
  warnings: string[]
}

export function fetchSandboxHealth(): Promise<ApiSuccess<SandboxHealthReport>> {
  return api<SandboxHealthReport>('/api/system/sandbox-health')
}
