export { prepareProviderAuth, type PrepareProviderAuthOptions } from './bridge'
export {
  ProviderAuthError,
  providerAuthFailureMessage,
  runProviderAuthPreflight
} from './preflight'
export {
  filterCodexConfigToml,
  materializeCodexAuth,
  materializeCursorAuth,
  materializeOpencodeAuth,
  ensureCursorRuntimeAuth,
  runtimeCursorCliAuthPath,
  opencodeRuntimeLayout
} from './materialize'
export {
  CREDENTIAL_SNAPSHOT_MANIFEST,
  credentialSnapshotManifestPath,
  scrubCredentialSnapshotManifest,
  scrubCredentialSnapshotsInTree,
  writeCredentialSnapshotManifest
} from './snapshot-manifest'
export {
  resolveCodexHostAuthPath,
  resolveCodexInstallDirs,
  resolveClaudeInstallDirs,
  resolveCursorHostAuthPath,
  resolveOpencodeInstallDirs,
  resolveOpencodeExecutable,
  resolveClaudeConfigReadRoots,
  resolveClaudeHostConfigDir,
  resolveClaudeProjectConfigDir,
  resolveHostProfilePaths,
  snapshotClaudeHostSettings,
  snapshotClaudeProjectSettings,
  resolveCursorAgentInstallDirs
} from './paths'
export type {
  ProviderAuthDiagnostics,
  ProviderAuthMode,
  ProviderAuthPrepared,
  ProviderFilesystemProfile,
  CredentialSnapshotSpec,
  ProviderAuthPreflightResult
} from './types'
