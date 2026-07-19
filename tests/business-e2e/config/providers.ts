/**
 * --providers CLI: single / comma-list / all → fixed SUT role profiles.
 * Aliases: cursor → cursorcli, claude → claude-code.
 * Naming a provider (or `all`) opts it in; no BUSINESS_ALLOW_* env.
 */

import {
  fixedProfileForCore,
  resolveProfile,
  type Profile,
  type SutCoreCode
} from './profiles'

export type ProviderAlias = 'opencode' | 'cursor' | 'claude' | 'codex'

export type ProviderRunSlot = {
  alias: ProviderAlias
  core: SutCoreCode
  profile: Profile
  /** When set, supervisor should skip this slot and record skipped. */
  skipReason?: string
}

const ALIAS_TO_CORE: Record<ProviderAlias, SutCoreCode> = {
  opencode: 'opencode',
  cursor: 'cursorcli',
  claude: 'claude-code',
  codex: 'codex'
}

/** Every supported provider alias — keep in sync with ALIAS_TO_CORE. */
const ALL_PROVIDERS = Object.keys(ALIAS_TO_CORE) as ProviderAlias[]

export function normalizeProviderAlias(raw: string): ProviderAlias {
  const v = raw.trim().toLowerCase()
  if (v === 'opencode' || v === 'oc') return 'opencode'
  if (v === 'cursor' || v === 'cursorcli' || v === 'cursor-acp' || v === 'cursoracp') {
    return 'cursor'
  }
  if (v === 'claude' || v === 'claude-code' || v === 'claudecode') return 'claude'
  if (v === 'codex') return 'codex'
  throw new Error(
    `unknown_provider:${raw}:use opencode|cursor|claude|codex|all (comma-separated)`
  )
}

export function parseProvidersList(raw: string | undefined): ProviderAlias[] | null {
  if (!raw?.trim()) return null
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === 'all') return [...ALL_PROVIDERS]
  const parts = trimmed.split(/[,+\s]+/).map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return null
  return parts.map(normalizeProviderAlias)
}

function aliasForCore(core: string): ProviderAlias {
  if (core === 'cursorcli') return 'cursor'
  if (core === 'claude-code') return 'claude'
  if (core === 'codex') return 'codex'
  return 'opencode'
}

/**
 * Resolve run queue. `--providers` wins over `--profile`.
 * When neither is set, default to a single opencode slot.
 * Explicit provider/profile selection runs immediately (no env gate).
 */
export function resolveProviderQueue(input: {
  providers?: string
  profile?: string
}): ProviderRunSlot[] {
  const fromFlag = parseProvidersList(input.providers)
  if (fromFlag) {
    return fromFlag.map((alias) => {
      const core = ALIAS_TO_CORE[alias]
      return {
        alias,
        core,
        profile: fixedProfileForCore(core)
      }
    })
  }

  const profile = resolveProfile(input.profile)
  const alias = aliasForCore(profile.roleProviders.conversation)
  return [
    {
      alias,
      core: ALIAS_TO_CORE[alias],
      profile
    }
  ]
}

/** OpenCode / Cursor / Claude CLI fragment root keys for settings MCP. */
export const CLI_MCP_ROOT_KEY: Record<SutCoreCode, string> = {
  opencode: 'mcp',
  cursorcli: 'mcpServers',
  'claude-code': 'mcpServers',
  codex: 'mcp_servers'
}

export const PROBE_SERVER_NAME = 'business-e2e-probe'

export const PROBE_OK = {
  conversation: 'PROBE_OK_CONVERSATION',
  task: 'PROBE_OK_TASK',
  verification: 'PROBE_OK_VERIFICATION'
} as const
