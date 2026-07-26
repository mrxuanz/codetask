import { pathCapability } from './compile-policy.ts'
import { getHostPathResolver } from './path-resolvers/index.ts'
import type { HostEnv, HostRoots, PlatformPathResolver } from './path-resolvers/types.ts'
import type { ProviderRuntimeProfile } from './types.ts'
import { PROVIDER_RUNTIME_PROFILE_VERSION } from './types.ts'

/**
 * Fake Provider profile for new-core paths — environment identity only.
 * Explicitly excludes credential copy / materialize / snapshot / host sync.
 */
export function createFakeProviderRuntimeProfile(
  overrides: Partial<ProviderRuntimeProfile> = {}
): ProviderRuntimeProfile {
  return {
    provider: 'fake',
    version: PROVIDER_RUNTIME_PROFILE_VERSION,
    environment: {},
    filesystem: {
      hostRead: [],
      hostWrite: [],
      instanceReadWrite: ['home', 'config', 'data', 'cache', 'state', 'tmp', 'log', 'ipc']
    },
    credentials: [{ type: 'environment', names: ['FAKE_API_KEY'] }],
    network: {
      allowInternetEgress: false,
      localhostAllowlist: [],
      allowListen: false
    },
    process: {},
    ...overrides
  }
}

export type BuildHostIdentityProfileInput = {
  readonly provider: string
  readonly resolver: PlatformPathResolver
  readonly roots: HostRoots
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly credentialEnvNames?: readonly string[]
  readonly allowCredentialWrite?: boolean
}

/**
 * Build a host-identity profile from precise resolver paths (no credential copy).
 */
export function createHostIdentityProfile(input: BuildHostIdentityProfileInput): ProviderRuntimeProfile {
  const identity = input.resolver.resolveIdentityPaths(
    input.provider,
    input.roots,
    input.env ?? {}
  )

  const access = input.allowCredentialWrite ? 'read-write' : 'read'
  const hostRead = [
    ...identity.credentialFiles.map((path) => pathCapability(path, 'read', 'credential', false)),
    ...identity.configDirs.map((path) => pathCapability(path, 'read', 'config', false))
  ]
  const hostWrite = input.allowCredentialWrite
    ? identity.credentialFiles.map((path) =>
        pathCapability(path, 'read-write', 'credential', false)
      )
    : []

  return {
    provider: input.provider,
    version: PROVIDER_RUNTIME_PROFILE_VERSION,
    environment: {},
    filesystem: {
      hostRead,
      hostWrite,
      instanceReadWrite: ['home', 'config', 'data', 'cache', 'state', 'tmp', 'log', 'ipc']
    },
    credentials: [
      ...(input.credentialEnvNames?.length
        ? [{ type: 'environment' as const, names: input.credentialEnvNames }]
        : []),
      {
        type: 'host-path',
        paths: identity.credentialFiles.map((path) =>
          pathCapability(path, access, 'credential', false)
        )
      }
    ],
    network: {
      allowInternetEgress: true,
      localhostAllowlist: [],
      allowListen: false
    },
    process: {}
  }
}

export type BuildProviderRuntimeProfileInput = {
  readonly resolver?: PlatformPathResolver
  readonly roots?: HostRoots
  readonly env?: HostEnv
  readonly allowCredentialWrite?: boolean
  readonly platform?: NodeJS.Platform
}

function resolveBuilderContext(input: BuildProviderRuntimeProfileInput = {}): {
  readonly resolver: PlatformPathResolver
  readonly roots: HostRoots
  readonly env: HostEnv
} {
  const env = input.env ?? process.env
  const resolver = input.resolver ?? getHostPathResolver(input.platform ?? process.platform)
  const roots = input.roots ?? resolver.resolveHostRoots(env)
  return { resolver, roots, env }
}

/**
 * OpenCode profile — precise XDG / AppData identity paths; never whole HOME.
 * Compiled policy always has credentialCopy: false.
 */
export function createOpenCodeProviderRuntimeProfile(
  input: BuildProviderRuntimeProfileInput = {}
): ProviderRuntimeProfile {
  const ctx = resolveBuilderContext(input)
  return createHostIdentityProfile({
    provider: 'opencode',
    resolver: ctx.resolver,
    roots: ctx.roots,
    env: ctx.env,
    credentialEnvNames: ['OPENCODE_API_KEY'],
    allowCredentialWrite: input.allowCredentialWrite
  })
}

/**
 * Codex profile — precise `$CODEX_HOME` / `~/.codex` identity; never whole HOME.
 * Compiled policy always has credentialCopy: false.
 */
export function createCodexProviderRuntimeProfile(
  input: BuildProviderRuntimeProfileInput = {}
): ProviderRuntimeProfile {
  const ctx = resolveBuilderContext(input)
  return createHostIdentityProfile({
    provider: 'codex',
    resolver: ctx.resolver,
    roots: ctx.roots,
    env: ctx.env,
    credentialEnvNames: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
    allowCredentialWrite: input.allowCredentialWrite
  })
}

/**
 * Claude Code profile — precise `CLAUDE_CONFIG_DIR` / `~/.claude`; never whole HOME.
 * Compiled policy always has credentialCopy: false.
 */
export function createClaudeProviderRuntimeProfile(
  input: BuildProviderRuntimeProfileInput = {}
): ProviderRuntimeProfile {
  const ctx = resolveBuilderContext(input)
  return createHostIdentityProfile({
    provider: 'claude',
    resolver: ctx.resolver,
    roots: ctx.roots,
    env: ctx.env,
    credentialEnvNames: ['ANTHROPIC_API_KEY'],
    allowCredentialWrite: input.allowCredentialWrite
  })
}

/**
 * Cursor profile — precise `.cursor` / AppData Cursor identity paths only.
 * Narrows former whole-HOME grants to resolver-produced identity paths.
 * Compiled policy always has credentialCopy: false.
 */
export function createCursorProviderRuntimeProfile(
  input: BuildProviderRuntimeProfileInput = {}
): ProviderRuntimeProfile {
  const ctx = resolveBuilderContext(input)
  return createHostIdentityProfile({
    provider: 'cursor',
    resolver: ctx.resolver,
    roots: ctx.roots,
    env: ctx.env,
    credentialEnvNames: ['CURSOR_API_KEY'],
    allowCredentialWrite: input.allowCredentialWrite
  })
}
