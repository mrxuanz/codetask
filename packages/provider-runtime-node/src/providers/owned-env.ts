import type { SupportedCoreCode } from '../spec/codes'
import { SUPPORTED_CORE_CODES } from '../spec/codes'
import { getProviderDescriptor } from '../spec/descriptors'

/**
 * Per-provider env keys adapters may inject into the child process.
 * Only third-party auth / provider-native keys — not CodeTask BIN/MODEL config.
 * Internal controls (authMode / outerSandbox) travel on
 * ProviderTurnContext, not env overlays.
 */
export const PROVIDER_OWNED_ENV_KEYS: Readonly<Record<SupportedCoreCode, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      SUPPORTED_CORE_CODES.map((code) => {
        const descriptor = getProviderDescriptor(code)
        return [
          code,
          Object.freeze([
            ...new Set([...descriptor.authEnvironmentKeys, ...descriptor.childEnvironmentKeys])
          ])
        ]
      })
    ) as Record<SupportedCoreCode, readonly string[]>
  )
