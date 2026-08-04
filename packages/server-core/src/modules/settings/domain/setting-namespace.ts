import { createHash } from 'crypto'
import {
  AGENT_MCP_ROLES,
  SETTING_NAMESPACES,
  type AgentPromptSettings,
  type SettingsProviderCode
} from '@codetask/contracts'

export { SETTING_NAMESPACES }
export type { SettingNamespace } from '@codetask/contracts'

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function isSettingNamespace(
  value: string
): value is import('@codetask/contracts').SettingNamespace {
  return (SETTING_NAMESPACES as readonly string[]).includes(value)
}

export const AGENT_MCP_ROLE_LIST: readonly import('@codetask/contracts').AgentMcpRole[] =
  AGENT_MCP_ROLES

/** Canonical settings provider codes (Batch F) — must match contracts ProviderCodeSchema. */
export const PROVIDER_CODES: readonly SettingsProviderCode[] = [
  'codex',
  'claude',
  'opencode',
  'cursor'
] as const

/**
 * Canonical / historical alias → Settings canonical provider code.
 */
const SETTINGS_PROVIDER_ALIASES: Readonly<Record<string, SettingsProviderCode>> = {
  codex: 'codex',
  claude: 'claude',
  'claude-code': 'claude',
  claude_code: 'claude',
  opencode: 'opencode',
  cursor: 'cursor',
  cursorcli: 'cursor',
  'cursor-cli': 'cursor',
  'cursor-agent': 'cursor',
  cursor_cli: 'cursor'
}

/**
 * Normalize any known provider spelling to Settings canonical codes.
 * Unknown values fall back to `cursor` (agent_defaults default).
 */
export function toSettingsProviderCode(
  value: string,
  fallback: SettingsProviderCode = 'cursor'
): SettingsProviderCode {
  return SETTINGS_PROVIDER_ALIASES[value.trim().toLowerCase()] ?? fallback
}

/** Resolve known provider spellings; return null when unknown (no silent fallback). */
export function trySettingsProviderCode(value: string): SettingsProviderCode | null {
  return SETTINGS_PROVIDER_ALIASES[value.trim().toLowerCase()] ?? null
}

export type DefaultPromptBodies = () => AgentPromptSettings
