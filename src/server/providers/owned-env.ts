import type { SupportedCoreCode } from '../../shared/providers/codes'
import { SUPPORTED_CORE_CODES } from '../../shared/providers/codes'
import { getProviderDescriptor } from '../../shared/providers/descriptors'

/**
 * Per-provider non-secret child protocol keys adapters may inject.
 * Internal controls (authMode / outerSandbox / runtimeRoot) travel on
 * ProviderTurnContext, not env overlays.
 */
export const PROVIDER_OWNED_ENV_KEYS: Readonly<Record<SupportedCoreCode, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      SUPPORTED_CORE_CODES.map((code) => {
        const descriptor = getProviderDescriptor(code)
        return [code, Object.freeze([...new Set(descriptor.childEnvironmentKeys)])]
      })
    ) as Record<SupportedCoreCode, readonly string[]>
  )
