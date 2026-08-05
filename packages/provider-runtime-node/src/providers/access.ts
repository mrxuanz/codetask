import { DEFAULT_PROVIDER_REGISTRY } from './composition'
import { ProviderRuntimeManager } from './lifecycle'
import type { ProviderRegistry } from './registry'

export type ProviderAccessDeps = {
  getRegistry: () => ProviderRegistry
  getRuntimeManager: () => ProviderRuntimeManager
}

const defaultRuntimeManager = new ProviderRuntimeManager()

let injected: ProviderAccessDeps | null = null

/**
 * Host composition root calls this once during bootstrap with the live registry.
 * Packages must not import `@server/bootstrap` to reach app context.
 */
export function setProviderAccess(deps: ProviderAccessDeps): void {
  injected = deps
}

export function clearProviderAccess(): void {
  injected = null
}

export function getProviderRegistry(): ProviderRegistry {
  return injected?.getRegistry() ?? DEFAULT_PROVIDER_REGISTRY
}

export function getProviderRuntimeManager(): ProviderRuntimeManager {
  return injected?.getRuntimeManager() ?? defaultRuntimeManager
}
