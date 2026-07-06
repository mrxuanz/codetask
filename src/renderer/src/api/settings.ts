import { api } from './client'
import type { ApiResponse } from './types'

export interface AgentCoreOption {
  code: string
  label: string
  description: string
  available: boolean
  reason?: string | null
}

export interface ControlPlanePolicies {
  plannerCoreCode: string
  sliceVerifierCoreCode: string
  milestoneVerifierCoreCode: string
  updatedAt: number
}

export interface ControlPlaneSettingsPayload {
  policies: ControlPlanePolicies
  cores: AgentCoreOption[]
}

export interface PromptBodySetting {
  body: string
  useDefault: boolean
}

export interface PromptSettings {
  conversation: PromptBodySetting
  planner: PromptBodySetting
  sliceVerifier: PromptBodySetting
  milestoneVerifier: PromptBodySetting
}

export interface PromptSettingsPayload {
  settings: PromptSettings
  defaults: PromptSettings
}

export function fetchControlPlaneSettings(): Promise<ApiResponse<ControlPlaneSettingsPayload>> {
  return api<ControlPlaneSettingsPayload>('/api/settings/control-plane')
}

export function updateControlPlanePolicies(input: {
  plannerCoreCode: string
  sliceVerifierCoreCode: string
  milestoneVerifierCoreCode: string
}): Promise<ApiResponse<{ policies: ControlPlanePolicies }>> {
  return api<{ policies: ControlPlanePolicies }>('/api/settings/control-plane', {
    method: 'PUT',
    body: JSON.stringify(input)
  })
}

export function fetchPromptSettings(): Promise<ApiResponse<PromptSettingsPayload>> {
  return api<PromptSettingsPayload>('/api/settings/prompts')
}

export function updatePromptSettings(
  settings: PromptSettings
): Promise<ApiResponse<{ settings: PromptSettings }>> {
  return api<{ settings: PromptSettings }>('/api/settings/prompts', {
    method: 'PUT',
    body: JSON.stringify({ settings })
  })
}

export type UserMcpRoleKey = 'conversation' | 'task' | 'verification'

export type CliMcpConfigFragment = Record<string, Record<string, unknown>>

export type RoleCliMcpSettings = Record<string, CliMcpConfigFragment>

export type UserMcpSettings = Record<UserMcpRoleKey, RoleCliMcpSettings>

export interface McpSettingsConstraints {
  reservedServerNames: string[]
  rootKeys: Record<string, string>
}

export interface McpSettingsPayload {
  settings: UserMcpSettings
  constraints: McpSettingsConstraints
}

export function fetchMcpSettings(): Promise<ApiResponse<McpSettingsPayload>> {
  return api<McpSettingsPayload>('/api/settings/mcp')
}

export function updateMcpSettings(
  settings: UserMcpSettings
): Promise<ApiResponse<{ settings: UserMcpSettings }>> {
  return api<{ settings: UserMcpSettings }>('/api/settings/mcp', {
    method: 'PUT',
    body: JSON.stringify({ settings })
  })
}
