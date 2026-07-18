import { SUPPORTED_CORE_CODES, type SupportedCoreCode } from '../conversation/cores'
import type { ConversationRole } from '../agent-runtime/roles'
import { createTurnError } from '../../shared/turn-errors.ts'
import { patchSettingsFile, readSettingsFile, resolveMcpSecretProvider } from './store'
import {
  collectMcpSecretReferenceIds,
  protectSubmittedMcpSensitiveValues,
  redactMcpSensitiveValues,
  resolveProtectedMcpSensitiveValues
} from './mcp-secrets'

export { MCP_SECRET_MASK } from './mcp-secrets'

export const USER_MCP_ROLES = ['conversation', 'task', 'verification'] as const
export type UserMcpRoleKey = (typeof USER_MCP_ROLES)[number]

export const CLI_MCP_ROOT_KEY: Record<SupportedCoreCode, string> = {
  'claude-code': 'mcpServers',
  codex: 'mcp_servers',
  cursorcli: 'mcpServers',
  opencode: 'mcp'
}

export const RESERVED_MCP_SERVER_NAMES = new Set([
  'codeteam-manager',
  'codeteam-planner',
  'codeteam-worker',
  'codeteam-milestone-verifier',
  'codeteam-slice-verifier'
])

export type CliMcpConfigFragment = Record<string, Record<string, unknown>>

export type RoleCliMcpSettings = Record<SupportedCoreCode, CliMcpConfigFragment>

export type UserMcpSettings = Record<UserMcpRoleKey, RoleCliMcpSettings>

export function redactUserMcpSettings(settings: UserMcpSettings): UserMcpSettings {
  return redactMcpSensitiveValues(settings) as UserMcpSettings
}

function emptyCliFragment(coreCode: SupportedCoreCode): CliMcpConfigFragment {
  return { [CLI_MCP_ROOT_KEY[coreCode]]: {} }
}

function defaultRoleCliSettings(): RoleCliMcpSettings {
  return Object.fromEntries(
    SUPPORTED_CORE_CODES.map((code) => [code, emptyCliFragment(code)])
  ) as RoleCliMcpSettings
}

export function defaultUserMcpSettings(): UserMcpSettings {
  const roleDefaults = defaultRoleCliSettings()
  return {
    conversation: structuredClone(roleDefaults),
    task: structuredClone(roleDefaults),
    verification: structuredClone(roleDefaults)
  }
}

export function conversationRoleToUserMcpRole(role: ConversationRole): UserMcpRoleKey {
  if (role === 'task-worker') return 'task'
  if (role === 'conversation' || role === 'planner') return 'conversation'
  return 'verification'
}

export function isReservedMcpServerName(name: string): boolean {
  return RESERVED_MCP_SERVER_NAMES.has(name.trim().toLowerCase())
}

function parseCliFragment(coreCode: SupportedCoreCode, value: unknown): CliMcpConfigFragment {
  const rootKey = CLI_MCP_ROOT_KEY[coreCode]
  if (!value || typeof value !== 'object') return emptyCliFragment(coreCode)

  const object = value as Record<string, unknown>
  const servers = object[rootKey]
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return emptyCliFragment(coreCode)
  }
  try {
    return { [rootKey]: sanitizeServerMap(servers, `${coreCode}.${rootKey}`) }
  } catch {
    return emptyCliFragment(coreCode)
  }
}

function sanitizeServerMap(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createTurnError('settings.mcp.invalid_fragment', {
      detail: `${path} must be an object`
    })
  }
  const map = value as Record<string, unknown>
  const cleaned: Record<string, unknown> = {}
  for (const [name, config] of Object.entries(map)) {
    const trimmed = name.trim()
    if (!trimmed) continue
    if (isReservedMcpServerName(trimmed)) {
      throw createTurnError('settings.mcp.reserved_name', {
        detail: `${path} uses reserved MCP server name: ${trimmed}`
      })
    }
    cleaned[trimmed] = config
  }
  return cleaned
}

function parseRoleSettings(value: unknown): RoleCliMcpSettings {
  const defaults = defaultRoleCliSettings()
  if (!value || typeof value !== 'object') return defaults
  const object = value as Record<string, unknown>
  const parsed = { ...defaults }
  for (const code of SUPPORTED_CORE_CODES) {
    parsed[code] = parseCliFragment(code, object[code])
  }
  return parsed
}

function validateCliFragment(
  coreCode: SupportedCoreCode,
  fragment: CliMcpConfigFragment,
  path: string
): CliMcpConfigFragment {
  const rootKey = CLI_MCP_ROOT_KEY[coreCode]
  const keys = Object.keys(fragment)
  if (keys.length !== 1 || keys[0] !== rootKey) {
    throw createTurnError('settings.mcp.invalid_root_key', {
      detail: `${path} must use root key ${rootKey}`
    })
  }
  return {
    [rootKey]: sanitizeServerMap(fragment[rootKey], `${path}.${rootKey}`)
  }
}

export function loadUserMcpSettings(): UserMcpSettings {
  const defaults = defaultUserMcpSettings()
  const raw = readSettingsFile().userMcp
  if (!raw || typeof raw !== 'object') return defaults

  const object = raw as Record<string, unknown>
  if (USER_MCP_ROLES.some((role) => role in object)) {
    return {
      conversation: parseRoleSettings(object.conversation),
      task: parseRoleSettings(object.task),
      verification: parseRoleSettings(object.verification)
    }
  }

  return defaults
}

export function resolveUserMcpServersMap(
  coreCode: SupportedCoreCode,
  role: ConversationRole
): Record<string, unknown> {
  const roleKey = conversationRoleToUserMcpRole(role)
  const fragment = loadUserMcpSettings()[roleKey][coreCode]
  const rootKey = CLI_MCP_ROOT_KEY[coreCode]
  const map = fragment[rootKey]
  if (!map || typeof map !== 'object') return {}
  return resolveProtectedMcpSensitiveValues({ ...map }, resolveMcpSecretProvider())
}

export function listUserMcpServerNames(map: Record<string, unknown>): string[] {
  return Object.keys(map)
}

export function saveUserMcpSettings(input: UserMcpSettings): UserMcpSettings {
  const current = loadUserMcpSettings()
  const saved = defaultUserMcpSettings()
  for (const role of USER_MCP_ROLES) {
    for (const code of SUPPORTED_CORE_CODES) {
      saved[role][code] = validateCliFragment(
        code,
        input[role]?.[code] ?? emptyCliFragment(code),
        `${role}.${code}`
      )
    }
  }

  const provider = resolveMcpSecretProvider()
  let protectedSettings: UserMcpSettings
  try {
    protectedSettings = protectSubmittedMcpSensitiveValues(saved, current, provider)
    patchSettingsFile((file) => {
      file.userMcp = protectedSettings
    })
  } catch (error) {
    provider.pruneExcept(collectMcpSecretReferenceIds(current))
    throw error
  }
  provider.pruneExcept(collectMcpSecretReferenceIds(protectedSettings))

  return protectedSettings
}

export const MCP_SETTINGS_CONSTRAINTS = {
  reservedServerNames: [...RESERVED_MCP_SERVER_NAMES],
  rootKeys: CLI_MCP_ROOT_KEY
} as const
