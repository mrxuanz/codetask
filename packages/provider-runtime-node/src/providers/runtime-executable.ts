import { posix, win32, type PlatformPath } from 'node:path'
import type { SupportedCoreCode } from '../spec/codes'
import type { ProviderInstallation, ProviderInstallationSource } from '../spec/installation'

export type ProviderExecutableStrategy = 'sdk-bundled' | 'installation'

const SDK_BUNDLED_PROVIDERS = new Set<SupportedCoreCode>(['claude', 'codex'])

/**
 * Claude Agent SDK and Codex SDK ship their own platform-native CLI. Automatic
 * discovery is still useful for provider availability and sandbox diagnostics,
 * but an arbitrary PATH/install-dir shim must not replace the SDK binary.
 *
 * A user-selected app-config path is an intentional override and remains
 * authoritative. Providers without a bundled CLI always use their installation.
 */
export function resolveProviderExecutableStrategy(
  provider: SupportedCoreCode,
  source?: ProviderInstallationSource
): ProviderExecutableStrategy {
  if (SDK_BUNDLED_PROVIDERS.has(provider) && source !== 'app-config') {
    return 'sdk-bundled'
  }
  return 'installation'
}

const SANDBOX_IDENTITY_ENV_KEYS = new Set(
  [
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'TMPDIR',
    'TEMP',
    'TMP',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC'
  ].map((key) => key.toLowerCase())
)

const SENSITIVE_ENV_KEY = /(?:auth|credential|key|password|secret|token|cookie)/i
const PATH_METADATA_ENV_KEY = /(?:^|_)(?:home|root|dir|path|prefix|symlink)$/i
const EXECUTION_INJECTION_ENV_KEYS = new Set(
  ['NODE_PATH', 'NODE_OPTIONS', 'PYTHONPATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'].map((key) =>
    key.toLowerCase()
  )
)

function pathApi(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

function normalizedAbsolutePath(
  value: string,
  platform: NodeJS.Platform,
  api: PlatformPath
): string | null {
  const clean = value.trim().replace(/^"|"$/g, '')
  if (!clean || !api.isAbsolute(clean)) return null
  const normalized = api.normalize(clean)
  if (normalized === api.parse(normalized).root) return null
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isSameOrDescendant(path: string, root: string, api: PlatformPath): boolean {
  const relative = api.relative(root, path)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
  )
}

export interface ExecutableEnvironmentAffinity {
  readonly environment: Readonly<Record<string, string>>
  readonly readRoots: readonly string[]
}

/**
 * Preserve only path-valued host metadata that encloses the selected executable
 * (or its canonical target). This supports current and future toolchain managers
 * without naming any manager or leaking the host identity/secret environment.
 */
export function resolveExecutableEnvironmentAffinity(
  installation: ProviderInstallation,
  hostEnvironment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform
): ExecutableEnvironmentAffinity {
  if (
    resolveProviderExecutableStrategy(installation.provider, installation.source) !== 'installation'
  ) {
    return { environment: Object.freeze({}), readRoots: Object.freeze([]) }
  }

  const api = pathApi(platform)
  const executablePaths = [
    installation.resolvedPath,
    installation.canonicalPath,
    installation.invocation.executable
  ]
    .map((path) => normalizedAbsolutePath(path, platform, api))
    .filter((path): path is string => path !== null)

  const environment: Record<string, string> = {}
  const readRoots: string[] = []
  const seenRoots = new Set<string>()

  for (const [key, value] of Object.entries(hostEnvironment)) {
    if (
      typeof value !== 'string' ||
      SANDBOX_IDENTITY_ENV_KEYS.has(key.toLowerCase()) ||
      EXECUTION_INJECTION_ENV_KEYS.has(key.toLowerCase()) ||
      SENSITIVE_ENV_KEY.test(key) ||
      !PATH_METADATA_ENV_KEY.test(key)
    ) {
      continue
    }

    const normalized = normalizedAbsolutePath(value, platform, api)
    if (!normalized || !executablePaths.some((path) => isSameOrDescendant(path, normalized, api))) {
      continue
    }

    environment[key] = value
    if (!seenRoots.has(normalized)) {
      seenRoots.add(normalized)
      readRoots.push(value.trim().replace(/^"|"$/g, ''))
    }
  }

  return {
    environment: Object.freeze(environment),
    readRoots: Object.freeze(readRoots)
  }
}
