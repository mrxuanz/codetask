import { createHash } from 'crypto'
import {
  AGENT_MCP_ROLES,
  SETTING_NAMESPACES,
  type AgentMcpRole,
  type AgentPromptSettings,
  type SettingsProviderCode
} from '@codetask/contracts'

export { SETTING_NAMESPACES }
export type { SettingNamespace } from '@codetask/contracts'

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function isSettingNamespace(value: string): value is import('@codetask/contracts').SettingNamespace {
  return (SETTING_NAMESPACES as readonly string[]).includes(value)
}

export const AGENT_MCP_ROLE_LIST: readonly AgentMcpRole[] = AGENT_MCP_ROLES

export const PROVIDER_CODES: readonly SettingsProviderCode[] = [
  'codex',
  'claude-code',
  'opencode',
  'cursorcli'
] as const

/** Canonical / host / alias → Settings host provider code (MCP map keys). */
const SETTINGS_PROVIDER_ALIASES: Readonly<Record<string, SettingsProviderCode>> = {
  codex: 'codex',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  claude_code: 'claude-code',
  opencode: 'opencode',
  cursor: 'cursorcli',
  cursorcli: 'cursorcli',
  'cursor-cli': 'cursorcli',
  'cursor-agent': 'cursorcli',
  cursor_cli: 'cursorcli'
}

/**
 * Normalize any known provider spelling to Settings host codes used as MCP role keys.
 * Unknown values fall back to `cursorcli` (agent_defaults default).
 */
export function toSettingsProviderCode(
  value: string,
  fallback: SettingsProviderCode = 'cursorcli'
): SettingsProviderCode {
  return SETTINGS_PROVIDER_ALIASES[value.trim().toLowerCase()] ?? fallback
}

export type DefaultPromptBodies = () => AgentPromptSettings
