import { getAppContext } from '../bootstrap'
import { DEFAULT_PROVIDER_REGISTRY } from './composition'
import { ProviderRuntimeManager } from './lifecycle'
import type { ProviderRegistry } from './registry'

const defaultRuntimeManager = new ProviderRuntimeManager()

export function getProviderRegistry(): ProviderRegistry {
  try {
    return getAppContext().providerRegistry
  } catch {
    return DEFAULT_PROVIDER_REGISTRY
  }
}

export function getProviderRuntimeManager(): ProviderRuntimeManager {
  try {
    return getAppContext().providerRuntimeManager
  } catch {
    return defaultRuntimeManager
  }
}
