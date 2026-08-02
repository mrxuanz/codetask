import { api } from './client'
import type { ApiResponse } from './types'

export interface AgentCoreOption {
  code: string
  label: string
  description: string
  available: boolean
  readOnlyCapable?: boolean
  reason?: string | null
}

export interface AgentDefaultsSettings {
  plannerProvider: string
  sliceVerifierProvider: string
  milestoneVerifierProvider: string
}

export interface AgentDefaultsPayload {
  settings: AgentDefaultsSettings
  revision: number
  updatedAt: number
}

export interface PromptEntry {
  mode: 'default' | 'custom'
  body: string
}

export interface AgentPromptSettings {
  conversation: PromptEntry
  planner: PromptEntry
  sliceVerifier: PromptEntry
  milestoneVerifier: PromptEntry
}

export interface PromptSettingsPayload {
  settings: AgentPromptSettings
  defaults: AgentPromptSettings
  revision: number
  updatedAt: number
}

export type UserMcpRoleKey = 'conversation' | 'planner' | 'task' | 'verification'

export type CliMcpConfigFragment = Record<string, Record<string, unknown>>

export type RoleCliMcpSettings = Record<string, CliMcpConfigFragment>

export type AgentMcpSettings = {
  roles: Record<UserMcpRoleKey, RoleCliMcpSettings>
}

export interface McpSettingsConstraints {
  reservedServerNames: string[]
  rootKeys: Record<string, string>
}

export interface McpSettingsPayload {
  settings: AgentMcpSettings
  constraints: McpSettingsConstraints
  revision: number
  updatedAt: number
}

export interface ProviderRuntimeSetting {
  enabled: boolean
  executable: { mode: 'auto' } | { mode: 'path'; path: string }
  model?: string
  endpoint?: string
  approveMcps: boolean
}

export interface ProviderSettingsPayload {
  saved: { providers: Record<string, ProviderRuntimeSetting> }
  effective: { providers: Record<string, ProviderRuntimeSetting> }
  revision: number
  updatedAt: number
  restartRequired: boolean
}

export interface SettingsWriteResult<T> {
  settings: T
  revision: number
  effect: 'new-operations' | 'restart-required'
  restartRequired: boolean
}

export interface SecretMeta {
  name: string
  backend: 'encrypted'
  configured: boolean
}

export function fetchAgentDefaults(): Promise<ApiResponse<AgentDefaultsPayload>> {
  return api<AgentDefaultsPayload>('/api/settings/agent-defaults')
}

export function updateAgentDefaults(
  settings: AgentDefaultsSettings,
  expectedRevision: number
): Promise<ApiResponse<SettingsWriteResult<AgentDefaultsSettings>>> {
  return api<SettingsWriteResult<AgentDefaultsSettings>>('/api/settings/agent-defaults', {
    method: 'PUT',
    body: JSON.stringify({ ...settings, expectedRevision })
  })
}

export function fetchPromptSettings(): Promise<ApiResponse<PromptSettingsPayload>> {
  return api<PromptSettingsPayload>('/api/settings/prompts')
}

export function updatePromptSettings(
  settings: AgentPromptSettings,
  expectedRevision: number
): Promise<ApiResponse<SettingsWriteResult<AgentPromptSettings>>> {
  return api<SettingsWriteResult<AgentPromptSettings>>('/api/settings/prompts', {
    method: 'PUT',
    body: JSON.stringify({ settings, expectedRevision })
  })
}

export function fetchMcpSettings(): Promise<ApiResponse<McpSettingsPayload>> {
  return api<McpSettingsPayload>('/api/settings/mcp')
}

export function updateMcpSettings(
  settings: AgentMcpSettings,
  expectedRevision: number
): Promise<ApiResponse<SettingsWriteResult<AgentMcpSettings>>> {
  return api<SettingsWriteResult<AgentMcpSettings>>('/api/settings/mcp', {
    method: 'PUT',
    body: JSON.stringify({ settings, expectedRevision })
  })
}

export function fetchProviderSettings(): Promise<ApiResponse<ProviderSettingsPayload>> {
  return api<ProviderSettingsPayload>('/api/settings/providers')
}

export function updateProviderSettings(
  providers: Record<string, ProviderRuntimeSetting>,
  expectedRevision: number
): Promise<ApiResponse<SettingsWriteResult<{ providers: Record<string, ProviderRuntimeSetting> }>>> {
  return api<SettingsWriteResult<{ providers: Record<string, ProviderRuntimeSetting> }>>(
    '/api/settings/providers',
    {
      method: 'PUT',
      body: JSON.stringify({ providers, expectedRevision })
    }
  )
}

export function fetchProviderCatalog(): Promise<
  ApiResponse<{ providers: AgentCoreOption[] }>
> {
  return api<{ providers: AgentCoreOption[] }>('/api/settings/provider-catalog')
}

export function fetchSecrets(): Promise<ApiResponse<{ secrets: SecretMeta[] }>> {
  return api<{ secrets: SecretMeta[] }>('/api/settings/secrets')
}

export function putSecret(name: string, value: string): Promise<ApiResponse<{ secret: SecretMeta }>> {
  return api<{ secret: SecretMeta }>(`/api/settings/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ value })
  })
}

export function deleteSecret(name: string): Promise<ApiResponse<{ deleted: boolean; name: string }>> {
  return api<{ deleted: boolean; name: string }>(
    `/api/settings/secrets/${encodeURIComponent(name)}`,
    { method: 'DELETE' }
  )
}
