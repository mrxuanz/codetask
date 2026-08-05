import type { AgentMcpRole, SettingsProviderCode, SecretReference } from '@codetask/contracts'
import { AGENT_MCP_ROLES } from '@codetask/contracts'
import { SettingsError } from './settings-errors.ts'
import {
  AGENT_MCP_ROLE_LIST,
  PROVIDER_CODES,
  trySettingsProviderCode
} from './setting-namespace.ts'

/** Provider MCP config root keys — aligned with shared provider descriptors. */
export const MCP_ROOT_KEYS: Record<SettingsProviderCode, string> = {
  codex: 'mcp_servers',
  claude: 'mcpServers',
  opencode: 'mcp',
  cursor: 'mcpServers'
}

export const RESERVED_MCP_SERVER_NAMES = new Set([
  'codetask-manager',
  'codeteam-planner',
  'codeteam-worker',
  'codetask-milestone-verifier',
  'codetask-slice-verifier'
])

export type McpProviderFragment = Record<string, Record<string, unknown>>

export type RoleMcpSettings = Record<SettingsProviderCode, McpProviderFragment>

export type AgentMcpSettings = {
  roles: Record<AgentMcpRole, RoleMcpSettings>
}

export type RedactedSecretReference = {
  $secret: string
  configured: true
}

export type McpSettingsConstraints = {
  reservedServerNames: readonly string[]
  rootKeys: Record<SettingsProviderCode, string>
}

export const MCP_SETTINGS_CONSTRAINTS: McpSettingsConstraints = {
  reservedServerNames: [...RESERVED_MCP_SERVER_NAMES],
  rootKeys: MCP_ROOT_KEYS
}

const PLAINText_SECRET_KEY = /token|password|api[_-]?key|authorization|secret/i

function emptyFragment(providerCode: SettingsProviderCode): McpProviderFragment {
  return { [MCP_ROOT_KEYS[providerCode]]: {} }
}

function defaultRoleMcpSettings(): RoleMcpSettings {
  return Object.fromEntries(
    PROVIDER_CODES.map((code) => [code, emptyFragment(code)])
  ) as RoleMcpSettings
}

export function defaultAgentMcpSettings(): AgentMcpSettings {
  const roleDefaults = defaultRoleMcpSettings()
  return {
    roles: Object.fromEntries(
      AGENT_MCP_ROLE_LIST.map((role) => [role, structuredClone(roleDefaults)])
    ) as Record<AgentMcpRole, RoleMcpSettings>
  }
}

export function isSecretReference(value: unknown): value is SecretReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return (
    keys.length === 1 &&
    keys[0] === '$secret' &&
    typeof record.$secret === 'string' &&
    record.$secret.length > 0
  )
}

export function isRedactedSecretReference(value: unknown): value is RedactedSecretReference {
  if (!isSecretReference(value)) return false
  return (value as RedactedSecretReference).configured === true
}

function isReservedMcpServerName(name: string): boolean {
  return RESERVED_MCP_SERVER_NAMES.has(name.trim().toLowerCase())
}

function sanitizeServerMap(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw SettingsError.badRequest('settings.mcp_invalid', `${path} must be an object`)
  }
  const map = value as Record<string, unknown>
  const cleaned: Record<string, unknown> = {}
  for (const [name, config] of Object.entries(map)) {
    const trimmed = name.trim()
    if (!trimmed) continue
    if (isReservedMcpServerName(trimmed)) {
      throw SettingsError.badRequest(
        'settings.mcp_reserved_name',
        `${path} uses reserved MCP server name: ${trimmed}`
      )
    }
    cleaned[trimmed] = config
  }
  return cleaned
}

function parseProviderFragment(
  providerCode: SettingsProviderCode,
  value: unknown
): McpProviderFragment {
  const rootKey = MCP_ROOT_KEYS[providerCode]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyFragment(providerCode)
  }
  const object = value as Record<string, unknown>
  const keys = Object.keys(object)
  if (keys.length === 0) return emptyFragment(providerCode)
  if (keys.length !== 1 || keys[0] !== rootKey) {
    throw SettingsError.badRequest(
      'settings.mcp_invalid',
      `${providerCode} must use root key ${rootKey}`
    )
  }
  return {
    [rootKey]: sanitizeServerMap(object[rootKey], `${providerCode}.${rootKey}`)
  }
}

function parseRoleSettings(value: unknown): RoleMcpSettings {
  const defaults = defaultRoleMcpSettings()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  const object = value as Record<string, unknown>
  const parsed = { ...defaults }
  for (const [rawCode, rawValue] of Object.entries(object)) {
    const code = trySettingsProviderCode(rawCode)
    if (!code) {
      throw SettingsError.badRequest('settings.provider_unknown', `Unknown provider: ${rawCode}`)
    }
    if (rawValue !== undefined) {
      parsed[code] = parseProviderFragment(code, rawValue)
    }
  }
  return parsed
}

export function parseAgentMcpSettings(value: unknown): AgentMcpSettings {
  const defaults = defaultAgentMcpSettings()
  if (value === undefined || value === null) return defaults
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw SettingsError.badRequest('settings.invalid_payload', 'agent_mcp must be an object')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'roles') {
      throw SettingsError.badRequest('settings.invalid_payload', `Unknown field: ${key}`)
    }
  }
  const rolesRaw = record.roles
  if (rolesRaw === undefined) return defaults
  if (typeof rolesRaw !== 'object' || Array.isArray(rolesRaw) || rolesRaw === null) {
    throw SettingsError.badRequest('settings.invalid_payload', 'roles must be an object')
  }
  const rolesObject = rolesRaw as Record<string, unknown>
  for (const key of Object.keys(rolesObject)) {
    if (!(AGENT_MCP_ROLES as readonly string[]).includes(key)) {
      throw SettingsError.badRequest('settings.invalid_payload', `Unknown MCP role: ${key}`)
    }
  }
  const roles = { ...defaults.roles }
  for (const role of AGENT_MCP_ROLE_LIST) {
    if (rolesObject[role] !== undefined) {
      roles[role] = parseRoleSettings(rolesObject[role])
    }
  }
  return { roles }
}

export function normalizeAgentMcpSettings(value: unknown): AgentMcpSettings {
  return parseAgentMcpSettings(value)
}

export function validateAgentMcpSettings(value: AgentMcpSettings): AgentMcpSettings {
  detectPlaintextSecrets(value)
  return value
}

export function detectPlaintextSecrets(value: unknown, path = 'agent_mcp'): void {
  if (value === null || value === undefined) return
  if (isSecretReference(value) || isRedactedSecretReference(value)) return
  if (typeof value === 'string') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => detectPlaintextSecrets(item, `${path}[${index}]`))
    return
  }
  if (typeof value !== 'object') return

  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    const childPath = `${path}.${key}`
    if (PLAINText_SECRET_KEY.test(key) && typeof child === 'string' && !isSecretReference(child)) {
      throw SettingsError.badRequest(
        'settings.invalid_payload',
        `Plaintext secret at ${childPath}; use a SecretReference instead`
      )
    }
    detectPlaintextSecrets(child, childPath)
  }
}

export function redactMcpSettingsForApi(settings: AgentMcpSettings): AgentMcpSettings {
  return walkAndRedact(settings) as AgentMcpSettings
}

function walkAndRedact(value: unknown): unknown {
  if (isSecretReference(value)) {
    return { $secret: value.$secret, configured: true as const }
  }
  if (Array.isArray(value)) {
    return value.map((item) => walkAndRedact(item))
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(record)) {
      next[key] = walkAndRedact(child)
    }
    return next
  }
  return value
}

export function resolveSecretRefs<T>(
  value: T,
  resolve: (name: string) => string,
  options?: { requireConfigured?: (name: string) => boolean }
): T {
  return walkResolveSecrets(value, resolve, options) as T
}

function walkResolveSecrets(
  value: unknown,
  resolve: (name: string) => string,
  options?: { requireConfigured?: (name: string) => boolean }
): unknown {
  if (isSecretReference(value) || isRedactedSecretReference(value)) {
    const name = value.$secret
    if (options?.requireConfigured && !options.requireConfigured(name)) {
      throw SettingsError.badRequest('settings.secret_not_found', `Secret not found: ${name}`)
    }
    return resolve(name)
  }
  if (Array.isArray(value)) {
    return value.map((item) => walkResolveSecrets(item, resolve, options))
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(record)) {
      next[key] = walkResolveSecrets(child, resolve, options)
    }
    return next
  }
  return value
}

export function extractMcpServersMap(
  settings: AgentMcpSettings,
  role: AgentMcpRole,
  providerCode: SettingsProviderCode
): Record<string, unknown> {
  const fragment = settings.roles[role][providerCode]
  const rootKey = MCP_ROOT_KEYS[providerCode]
  const map = fragment[rootKey]
  if (!map || typeof map !== 'object') return {}
  return { ...map }
}

export function collectSecretReferences(value: unknown, names = new Set<string>()): Set<string> {
  if (isSecretReference(value) || isRedactedSecretReference(value)) {
    names.add(value.$secret)
    return names
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSecretReferences(item, names)
    return names
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectSecretReferences(child, names)
    }
  }
  return names
}
