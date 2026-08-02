import { composeSettingsModule, type SettingsModule, type SettingsModuleDeps } from './composition.ts'

export type { SettingsModule, SettingsModuleDeps }
export { composeSettingsModule }

export { SettingsError } from './domain/settings-errors.ts'
export {
  contentHash,
  SETTING_NAMESPACES,
  PROVIDER_CODES,
  AGENT_MCP_ROLE_LIST,
  toSettingsProviderCode,
  type DefaultPromptBodies
} from './domain/setting-namespace.ts'

export {
  defaultAgentDefaultsSettings,
  normalizeAgentDefaultsSettings,
  parseAgentDefaultsSettings,
  validateAgentDefaultsSettings
} from './domain/agent-defaults.ts'

export {
  defaultAgentPromptSettings,
  normalizeAgentPromptSettings,
  parseAgentPromptSettings,
  validateAgentPromptSettings,
  MAX_PROMPT_BODY_LENGTH
} from './domain/agent-prompts.ts'

export {
  defaultAgentMcpSettings,
  normalizeAgentMcpSettings,
  parseAgentMcpSettings,
  validateAgentMcpSettings,
  redactMcpSettingsForApi,
  resolveSecretRefs,
  extractMcpServersMap,
  collectSecretReferences,
  detectPlaintextSecrets,
  MCP_ROOT_KEYS,
  MCP_SETTINGS_CONSTRAINTS,
  RESERVED_MCP_SERVER_NAMES,
  type AgentMcpSettings,
  type RoleMcpSettings,
  type McpProviderFragment,
  type McpSettingsConstraints
} from './domain/agent-mcp.ts'

export {
  defaultProviderRuntimeSettings,
  normalizeProviderRuntimeSettings,
  parseProviderRuntimeSettings,
  validateProviderRuntimeSettings,
  mergeProviderRuntimeSettings,
  providerRuntimeRestartRequired
} from './domain/provider-runtime-settings.ts'

export { SettingsApplication, type SettingsApplicationDeps } from './application/settings-application.ts'

export type { SettingsRepository, StoredNamespace, WriteNamespaceResult } from './ports/settings-repository.ts'
export type { SecretStore, SecretMeta } from './ports/secret-store.ts'
export type { SettingsEventsPort } from './ports/settings-events.ts'
export type { ProviderCatalogPort, ProviderCatalogEntry } from './ports/provider-catalog.ts'

export { SqliteSettingsRepository } from './infrastructure/sqlite-settings-repository.ts'
export { EncryptedSecretStore } from './infrastructure/encrypted-secret-store.ts'

export { createSettingsHttpRoutes, type SettingsHttpDeps } from './http/settings-routes.ts'
