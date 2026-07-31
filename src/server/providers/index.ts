export type { SupportedCoreCode } from '../../shared/providers/codes'
export { SUPPORTED_CORE_CODES, isSupportedCoreCode } from '../../shared/providers/codes'

export type {
  ExecutableSource,
  ResolvedExecutable,
  EnvVarSource,
  LaunchEnvVarSummary,
  LaunchSummary,
  LaunchSpec,
  LaunchContext
} from './types'

export { PROVIDER_CLI_CANDIDATES } from './commands'
export { resolveProviderExecutable } from './executable'
export { spawnProviderInvocation, spawnProviderProcess } from './spawn'
export type { SpawnProviderInvocationOptions, SpawnProviderProcessOptions } from './spawn'
export { SANDBOX_CANCELLED_EXIT_CODE, signalToShellExitCode } from './exit-codes'
export {
  snapshotHostEnv,
  stripCodeTaskTransientEnv,
  applyProviderOverlay,
  buildLaunchEnv,
  buildLaunchSummary,
  buildLaunchSpec
} from './launch-env'
export {
  DefaultEnvironmentCompiler,
  defaultEnvironmentCompiler,
  CODETASK_TRANSIENT_ENV_KEYS
} from './environment'
export type { EnvironmentCompileInput, EnvironmentCompiler } from './environment'
export {
  processHostEnvironmentSource,
  initializeProcessHostEnvironment,
  resolveHostEnvironment,
  processHostAuthSource,
  ProcessHostAuthSource,
  ProcessHostEnvironmentSource
} from '../host-environment'
export type {
  HostEnvironmentSnapshot,
  HostEnvironmentSource,
  HostEnvironmentCommandRunner,
  ResolveHostEnvironmentOptions,
  HostAuthSource,
  HostAuthKeyPresence
} from '../host-environment'
