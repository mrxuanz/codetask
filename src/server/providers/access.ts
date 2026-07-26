import { DEFAULT_PROVIDER_REGISTRY } from './composition'
import { ProviderRuntimeManager } from './lifecycle'
import type { ProviderRegistry } from './registry'

const defaultRuntimeManager = new ProviderRuntimeManager()

export function getProviderRegistry(): ProviderRegistry {
  return DEFAULT_PROVIDER_REGISTRY
}

export function getProviderRuntimeManager(): ProviderRuntimeManager {
  return defaultRuntimeManager
}
