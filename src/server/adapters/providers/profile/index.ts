/**
 * Provider runtime profile package (Wave 7A).
 *
 * Invariant: NEW adapters under `src/server/adapters/providers/**` must not
 * implement credential copy, materialize, credential snapshot, or host sync.
 * Legacy paths under `src/server/providers` / `src/server/agent-runtime` /
 * `src/server/sandbox/provider-auth` remain until Wave 10 cutover deletion.
 * See `NO_CREDENTIAL_COPY.md`.
 */

export {
  PROVIDER_RUNTIME_PROFILE_VERSION,
  isNewPathAuthMode,
  type CredentialAccessMethod,
  type InstancePathKind,
  type NewPathAuthMode,
  type PathAccess,
  type PathCapability,
  type PathPurpose,
  type ProviderNetworkProfile,
  type ProviderProcessProfile,
  type ProviderProfileCode,
  type ProviderRuntimeFilesystem,
  type ProviderRuntimeProfile
} from './types.ts'

export {
  allocateInstanceDirs,
  assertInstanceDirsIsolated,
  cleanupInstanceDirs,
  instanceRootPath,
  pathForInstanceKind,
  type AllocateInstanceDirsInput,
  type InstanceDirs,
  type InstanceManifest
} from './instance-dirs.ts'

export {
  buildInstanceEnvRedirect,
  mergeProfileEnvironment,
  type EnvRedirectPlatform
} from './env-redirect.ts'

export {
  assertWhitelistEscapeDenied,
  compileProfileToPolicyInput,
  isPathAllowedByPolicy,
  pathCapability,
  ProfileCompileError,
  type CompileProfileInput,
  type EffectivePolicyInput
} from './compile-policy.ts'

export {
  CredentialLeaseError,
  CredentialLeaseStore,
  defaultCredentialLeaseStore,
  type AcquireCredentialLeaseInput,
  type CredentialLease
} from './credential-lease.ts'

export {
  createClaudeProviderRuntimeProfile,
  createCodexProviderRuntimeProfile,
  createCursorProviderRuntimeProfile,
  createFakeProviderRuntimeProfile,
  createHostIdentityProfile,
  createOpenCodeProviderRuntimeProfile,
  type BuildHostIdentityProfileInput,
  type BuildProviderRuntimeProfileInput
} from './build-profile.ts'

export {
  assertNotWholeHome,
  ensureUnderHome,
  getHostPathResolver,
  getPathResolver,
  linuxPathResolver,
  macosPathResolver,
  PathResolverError,
  windowsPathResolver,
  type HostEnv,
  type HostRoots,
  type PathResolverPlatform,
  type PlatformPathResolver,
  type ProviderIdentityPaths
} from './path-resolvers/index.ts'
