import type { SupportedCoreCode } from '../../shared/providers/codes'
import { getProviderDescriptors } from '../../shared/providers/descriptors'

/** Single source of PATH / CLI name candidates for detect, preflight, and read-roots. */
export const PROVIDER_CLI_CANDIDATES: Readonly<Record<SupportedCoreCode, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(getProviderDescriptors()).map(([code, descriptor]) => [
        code,
        descriptor.defaultCommands
      ])
    ) as Record<SupportedCoreCode, readonly string[]>
  )
