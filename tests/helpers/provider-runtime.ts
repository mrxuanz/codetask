import type { SupportedCoreCode } from '../../src/shared/providers/codes.ts'
import type { ProviderAuthPrepared } from '../../src/server/sandbox/provider-auth/types.ts'
import { createProviderRegistry } from '../../src/server/providers/composition.ts'
import type { ProviderDriver } from '../../src/server/providers/driver.ts'
import { processHostEnvironmentSource } from '../../src/server/host-environment.ts'

const registry = createProviderRegistry()

export function prepareProviderAuthForTest(
  provider: SupportedCoreCode,
  runtimeRoot: string,
  options: {
    workspaceRoot?: string | undefined
    hostEnvironment?: Readonly<Record<string, string | undefined>> | undefined
  } = {}
): ProviderAuthPrepared {
  const hostEnvironment = Object.freeze({
    ...processHostEnvironmentSource.snapshot(),
    ...options.hostEnvironment
  })
  return registry.get(provider).prepareAuth({
    runtimeRoot,
    workspaceRoot: options.workspaceRoot,
    hostEnvironment
  })
}

export function getProviderDriverForTest(provider: SupportedCoreCode): ProviderDriver {
  return registry.get(provider)
}
