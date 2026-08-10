export const SUPPORTED_CORE_CODES = ['codex', 'claude', 'opencode', 'cursor'] as const
export type SupportedCoreCode = (typeof SUPPORTED_CORE_CODES)[number]

export const PROVIDER_CODE_ALIASES: Readonly<Record<string, SupportedCoreCode>> = {
  codex: 'codex',
  claude: 'claude',
  claude_code: 'claude',
  'claude-code': 'claude',
  opencode: 'opencode',
  cursor: 'cursor',
  'cursor-cli': 'cursor',
  'cursor-agent': 'cursor',
  cursor_cli: 'cursor',
  cursorcli: 'cursor'
}

export function isSupportedCoreCode(value: string): value is SupportedCoreCode {
  return (SUPPORTED_CORE_CODES as readonly string[]).includes(value)
}

export function normalizeProviderCode(value: string): SupportedCoreCode | null {
  return PROVIDER_CODE_ALIASES[value.trim().toLowerCase()] ?? null
}

export const PROVIDER_CAPABILITY_PROFILES = [
  'chat-write',
  'chat-read',
  'planner-read',
  'task-sandbox',
  'verifier-sandbox'
] as const

export type ProviderCapabilityProfile = (typeof PROVIDER_CAPABILITY_PROFILES)[number]
export type ProviderProtocol = 'sdk' | 'acp' | 'local-server'
export type ProviderAuthMode = 'host-identity'
export type ProviderReusePolicy = 'one-shot' | 'conversation-scoped'
export type ProviderConversationScopeKind = 'chat'

export interface ProviderRuntimeScope {
  readonly id: string
  readonly reusePolicy: ProviderReusePolicy
}

export function buildConversationProviderRuntimeScopeId(
  conversationId: string,
  _kind: ProviderConversationScopeKind = 'chat'
): string {
  return `conversation:${conversationId}`
}

export interface ProviderCapabilities {
  readonly authMode: ProviderAuthMode
  readonly protocol: ProviderProtocol
  readonly supportedProfiles: readonly ProviderCapabilityProfile[]
  readonly reuse: readonly ProviderReusePolicy[]
  readonly supportsIsolatedHome: false
}

export interface ProviderDescriptor {
  readonly code: SupportedCoreCode
  readonly aliases: readonly string[]
  readonly label: string
  readonly description: string
  readonly defaultCommands: readonly string[]
  readonly authEnvironmentKeys: readonly string[]
  readonly childEnvironmentKeys: readonly string[]
  readonly mcpRootKey: 'mcp_servers' | 'mcpServers' | 'mcp'
  readonly capabilities: ProviderCapabilities
}

export const CODEX_DESCRIPTOR = Object.freeze({
  code: 'codex',
  aliases: ['codex'],
  label: 'Codex',
  description: 'OpenAI Codex CLI',
  defaultCommands: ['codex'],
  authEnvironmentKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  childEnvironmentKeys: ['CODEX_HOME'],
  mcpRootKey: 'mcp_servers',
  capabilities: {
    authMode: 'host-identity',
    protocol: 'sdk',
    supportedProfiles: [...PROVIDER_CAPABILITY_PROFILES],
    reuse: ['one-shot', 'conversation-scoped'],
    supportsIsolatedHome: false
  }
} satisfies ProviderDescriptor)

export const CLAUDE_DESCRIPTOR = Object.freeze({
  code: 'claude',
  aliases: ['claude', 'claude_code', 'claude-code'],
  label: 'Claude Code',
  description: 'Anthropic Claude Code CLI',
  defaultCommands: ['claude', 'claude-code'],
  authEnvironmentKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  childEnvironmentKeys: [
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL'
  ],
  mcpRootKey: 'mcpServers',
  capabilities: {
    authMode: 'host-identity',
    protocol: 'sdk',
    supportedProfiles: [...PROVIDER_CAPABILITY_PROFILES],
    reuse: ['one-shot', 'conversation-scoped'],
    supportsIsolatedHome: false
  }
} satisfies ProviderDescriptor)

export const OPENCODE_DESCRIPTOR = Object.freeze({
  code: 'opencode',
  aliases: ['opencode'],
  label: 'OpenCode',
  description: 'OpenCode CLI',
  defaultCommands: ['opencode'],
  authEnvironmentKeys: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_API_KEY'],
  childEnvironmentKeys: [
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'OPENCODE_CONFIG_CONTENT'
  ],
  mcpRootKey: 'mcp',
  capabilities: {
    authMode: 'host-identity',
    protocol: 'local-server',
    supportedProfiles: [...PROVIDER_CAPABILITY_PROFILES],
    reuse: ['one-shot', 'conversation-scoped'],
    supportsIsolatedHome: false
  }
} satisfies ProviderDescriptor)

export const CURSOR_DESCRIPTOR = Object.freeze({
  code: 'cursor',
  aliases: ['cursor', 'cursor-cli', 'cursor-agent', 'cursor_cli', 'cursorcli'],
  label: 'Cursor CLI',
  description: 'Cursor Agent CLI',
  defaultCommands: ['agent', 'cursor-agent'],
  authEnvironmentKeys: ['CURSOR_API_KEY'],
  childEnvironmentKeys: ['CURSOR_CONFIG_DIR'],
  mcpRootKey: 'mcpServers',
  capabilities: {
    authMode: 'host-identity',
    protocol: 'acp',
    supportedProfiles: [...PROVIDER_CAPABILITY_PROFILES],
    reuse: ['one-shot', 'conversation-scoped'],
    supportsIsolatedHome: false
  }
} satisfies ProviderDescriptor)

const DESCRIPTORS: Readonly<Record<SupportedCoreCode, ProviderDescriptor>> = Object.freeze({
  codex: CODEX_DESCRIPTOR,
  claude: CLAUDE_DESCRIPTOR,
  opencode: OPENCODE_DESCRIPTOR,
  cursor: CURSOR_DESCRIPTOR
})

export function getProviderDescriptor(code: SupportedCoreCode): ProviderDescriptor {
  return DESCRIPTORS[code]
}

export function listProviderDescriptors(): readonly ProviderDescriptor[] {
  return SUPPORTED_CORE_CODES.map((code) => DESCRIPTORS[code])
}

export function getProviderDescriptors(): Readonly<Record<SupportedCoreCode, ProviderDescriptor>> {
  return DESCRIPTORS
}

export type ProviderExecutableSetting =
  | { readonly mode: 'auto' }
  | { readonly mode: 'path'; readonly path: string }

export interface ProviderSettings {
  readonly enabled: boolean
  readonly executable: ProviderExecutableSetting
  readonly model?: string | undefined
  readonly endpoint?: string | undefined
  readonly approveMcps: boolean
}

export type ProvidersConfig = Readonly<Record<SupportedCoreCode, ProviderSettings>>
export type ProviderSettingsOverride = Partial<
  Omit<ProviderSettings, 'executable'> & { executable: ProviderExecutableSetting }
>
export type ProvidersConfigOverrides = Partial<Record<SupportedCoreCode, ProviderSettingsOverride>>

function defaultProviderSettings(code: SupportedCoreCode): ProviderSettings {
  return { enabled: true, executable: { mode: 'auto' }, approveMcps: code === 'cursor' }
}

export const DEFAULT_PROVIDERS_CONFIG: ProvidersConfig = Object.freeze(
  Object.fromEntries(
    SUPPORTED_CORE_CODES.map((code) => [code, Object.freeze(defaultProviderSettings(code))])
  ) as Record<SupportedCoreCode, ProviderSettings>
)

function optionalTrimmedString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

export function validateProviderSettings(
  code: SupportedCoreCode,
  value: ProviderSettings
): ProviderSettings {
  if (typeof value.enabled !== 'boolean') {
    throw new Error(`providers.${code}.enabled must be a boolean`)
  }
  if (typeof value.approveMcps !== 'boolean') {
    throw new Error(`providers.${code}.approveMcps must be a boolean`)
  }
  if (!value.executable || (value.executable.mode !== 'auto' && value.executable.mode !== 'path')) {
    throw new Error(`providers.${code}.executable.mode must be auto or path`)
  }
  const executable =
    value.executable.mode === 'path'
      ? {
          mode: 'path' as const,
          path:
            optionalTrimmedString(value.executable.path, `providers.${code}.executable.path`) ?? ''
        }
      : { mode: 'auto' as const }
  return Object.freeze({
    enabled: value.enabled,
    executable,
    model: optionalTrimmedString(value.model, `providers.${code}.model`),
    endpoint: optionalTrimmedString(value.endpoint, `providers.${code}.endpoint`),
    approveMcps: value.approveMcps
  })
}

export function createProvidersConfig(overrides: ProvidersConfigOverrides = {}): ProvidersConfig {
  return Object.freeze(
    Object.fromEntries(
      SUPPORTED_CORE_CODES.map((code) => {
        const base = DEFAULT_PROVIDERS_CONFIG[code]
        const override = overrides[code]
        return [
          code,
          validateProviderSettings(code, {
            ...base,
            ...override,
            executable: override?.executable ?? base.executable
          })
        ]
      })
    ) as Record<SupportedCoreCode, ProviderSettings>
  )
}

export function mergeProvidersConfigOverrides(
  base: ProvidersConfigOverrides | undefined,
  override: ProvidersConfigOverrides | undefined
): ProvidersConfigOverrides {
  return Object.fromEntries(
    SUPPORTED_CORE_CODES.map((code) => {
      const baseValue = base?.[code]
      const overrideValue = override?.[code]
      return [
        code,
        {
          ...baseValue,
          ...overrideValue,
          executable: overrideValue?.executable ?? baseValue?.executable
        }
      ]
    })
  ) as ProvidersConfigOverrides
}

const PROVIDER_SETTING_KEYS = new Set(['enabled', 'executable', 'model', 'endpoint', 'approveMcps'])

export function parseProvidersConfigOverrides(value: unknown): ProvidersConfigOverrides {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('providers must be an object')
  const record = value as Record<string, unknown>
  for (const code of Object.keys(record)) {
    if (!SUPPORTED_CORE_CODES.includes(code as SupportedCoreCode)) {
      throw new Error(`providers.${code} is not a supported Provider`)
    }
    const provider = record[code]
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      throw new Error(`providers.${code} must be an object`)
    }
    for (const key of Object.keys(provider)) {
      if (!PROVIDER_SETTING_KEYS.has(key))
        throw new Error(`providers.${code}.${key} is not supported`)
    }
    const executable = (provider as Record<string, unknown>).executable
    if (executable !== undefined) {
      if (!executable || typeof executable !== 'object' || Array.isArray(executable)) {
        throw new Error(`providers.${code}.executable must be an object`)
      }
      const executableRecord = executable as Record<string, unknown>
      for (const key of Object.keys(executableRecord)) {
        if (key !== 'mode' && key !== 'path') {
          throw new Error(`providers.${code}.executable.${key} is not supported`)
        }
      }
      if (executableRecord.mode === 'auto' && executableRecord.path !== undefined) {
        throw new Error(`providers.${code}.executable.path requires mode path`)
      }
    }
  }
  return record as ProvidersConfigOverrides
}

export function parseProvidersConfig(value: unknown): ProvidersConfig {
  return createProvidersConfig(parseProvidersConfigOverrides(value))
}

export type ProviderInstallationSource = 'app-config' | 'install-dir' | 'path'
export interface CommandInvocation {
  readonly executable: string
  readonly prefixArgs: readonly string[]
}
export interface ProviderInstallation {
  readonly id: string
  readonly provider: SupportedCoreCode
  readonly command: string
  readonly source: ProviderInstallationSource
  readonly invocation: CommandInvocation
  readonly resolvedPath: string
  readonly canonicalPath: string
}
export type ProviderPreflightErrorCode =
  | 'disabled'
  | 'not-installed'
  | 'not-authenticated'
  | 'config-invalid'
  | 'probe-failed'
export interface ProviderPreflightResult {
  readonly ok: boolean
  readonly provider: SupportedCoreCode
  readonly errorCode?: ProviderPreflightErrorCode | undefined
  readonly message?: string | undefined
  readonly userAction?: string | undefined
}
