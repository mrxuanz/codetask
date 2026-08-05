/**
 * Concrete Provider SDK/ACP ownership (Batch F2).
 * server-core / AgentRuntime port → this package → drivers → SDK/ACP.
 *
 * Provider codes/descriptors/settings live in `./spec` (no host `@shared` dependency).
 */
export { createProviderRegistry, DEFAULT_PROVIDER_REGISTRY } from './providers/composition.ts'
export { ProviderRegistry } from './providers/registry.ts'
export {
  getProviderRegistry,
  getProviderRuntimeManager,
  setProviderAccess,
  clearProviderAccess
} from './providers/access.ts'
export { ProviderRuntimeManager } from './providers/lifecycle.ts'
export { getAgentTurnProvider } from './streamers/index.ts'
export type { ProviderDriver } from './providers/driver.ts'
export type { ProviderRegistry as ProviderRegistryType } from './providers/registry.ts'

export {
  SUPPORTED_CORE_CODES,
  PROVIDER_CODE_ALIASES,
  isSupportedCoreCode,
  normalizeProviderCode,
  getProviderDescriptor,
  getProviderDescriptors,
  listProviderDescriptors,
  DEFAULT_PROVIDERS_CONFIG,
  createProvidersConfig,
  mergeProvidersConfigOverrides,
  parseProvidersConfig,
  parseProvidersConfigOverrides,
  validateProviderSettings,
  PROVIDER_CAPABILITY_PROFILES,
  buildConversationProviderRuntimeScopeId
} from './spec/index.ts'
export type {
  SupportedCoreCode,
  ProviderAuthMode,
  ProviderCapabilities,
  ProviderCapabilityProfile,
  ProviderConversationScopeKind,
  ProviderProtocol,
  ProviderReusePolicy,
  ProviderRuntimeScope,
  ProviderDescriptor,
  ProviderExecutableSetting,
  ProviderSettings,
  ProviderSettingsOverride,
  ProvidersConfig,
  ProvidersConfigOverrides,
  CommandInvocation,
  ProviderInstallation,
  ProviderInstallationSource,
  ProviderPreflightErrorCode,
  ProviderPreflightResult
} from './spec/index.ts'
