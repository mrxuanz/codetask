import { isAbsolute, normalize, resolve, sep } from 'node:path'
import type { InstanceDirs } from './instance-dirs.ts'
import { pathForInstanceKind } from './instance-dirs.ts'
import { mergeProfileEnvironment } from './env-redirect.ts'
import type {
  CredentialAccessMethod,
  PathCapability,
  ProviderNetworkProfile,
  ProviderProcessProfile,
  ProviderRuntimeProfile
} from './types.ts'
import { PROVIDER_RUNTIME_PROFILE_VERSION } from './types.ts'

/**
 * Effective native policy *input* object produced from a ProviderRuntimeProfile.
 * Runtime Adapter + `.node` consume this; Providers cannot append after compile.
 *
 * NEW path: identity is allowlisted host paths / env / keyring — never credential copy.
 */

export interface EffectivePolicyInput {
  readonly version: number
  readonly provider: string
  readonly cwd: string
  readonly instanceRoot: string
  readonly allowedReadRoots: readonly string[]
  readonly allowedWriteRoots: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly network: ProviderNetworkProfile
  readonly process: ProviderProcessProfile
  readonly credentials: readonly CredentialAccessMethod[]
  /** Explicit: new adapters never request credential copy. */
  readonly credentialCopy: false
}

export class ProfileCompileError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ProfileCompileError'
    this.code = code
  }
}

export interface CompileProfileInput {
  readonly profile: ProviderRuntimeProfile
  readonly instanceDirs: InstanceDirs
  readonly cwd: string
  readonly workspaceRoot?: string | undefined
  readonly workspaceWrite?: boolean | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly hostHome?: string | undefined
}

function canonicalize(path: string): string {
  return normalize(resolve(path))
}

function isPathInsideOrEqual(candidate: string, root: string): boolean {
  const c = canonicalize(candidate)
  const r = canonicalize(root)
  if (c === r) return true
  const prefix = r.endsWith(sep) ? r : `${r}${sep}`
  return c.startsWith(prefix) || c.toLowerCase().startsWith(prefix.toLowerCase())
}

function assertAbsolutePrecise(path: string, hostHome: string | undefined): void {
  if (!isAbsolute(path)) {
    throw new ProfileCompileError(
      `Profile path must be absolute: ${path}`,
      'profile.compile.path_not_absolute'
    )
  }
  if (path.includes('$') || /%[A-Za-z0-9_]+%/.test(path)) {
    throw new ProfileCompileError(
      `Unexpanded variable in profile path: ${path}`,
      'profile.compile.unexpanded'
    )
  }
  if (hostHome) {
    const home = canonicalize(hostHome)
    if (canonicalize(path) === home) {
      throw new ProfileCompileError(
        `Whole HOME is forbidden in profile allowlist: ${path}`,
        'profile.compile.whole_home'
      )
    }
  }
  const dangerous = new Set(['/', 'c:\\', 'c:/'])
  if (dangerous.has(canonicalize(path).toLowerCase())) {
    throw new ProfileCompileError(
      `Disk root is forbidden in profile allowlist: ${path}`,
      'profile.compile.disk_root'
    )
  }
}

function validateProfile(profile: ProviderRuntimeProfile): void {
  if (!profile.provider?.trim()) {
    throw new ProfileCompileError('provider is required', 'profile.compile.incomplete')
  }
  if (!Number.isInteger(profile.version) || profile.version < 1) {
    throw new ProfileCompileError('profile.version must be >= 1', 'profile.compile.incomplete')
  }
  if (profile.version > PROVIDER_RUNTIME_PROFILE_VERSION) {
    throw new ProfileCompileError(
      `Unsupported profile version ${profile.version}`,
      'profile.compile.unsupported_version'
    )
  }
  if (!profile.filesystem) {
    throw new ProfileCompileError('filesystem is required', 'profile.compile.incomplete')
  }
  if (!profile.credentials) {
    throw new ProfileCompileError('credentials is required', 'profile.compile.incomplete')
  }
  if (!profile.network) {
    throw new ProfileCompileError('network is required', 'profile.compile.incomplete')
  }
  if (!profile.process) {
    throw new ProfileCompileError('process is required', 'profile.compile.incomplete')
  }
}

function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    const key = canonicalize(path).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(canonicalize(path))
  }
  return out
}

/**
 * Compile a versioned profile into effective policy input (fail closed if incomplete).
 */
export function compileProfileToPolicyInput(input: CompileProfileInput): EffectivePolicyInput {
  const { profile, instanceDirs, cwd } = input
  validateProfile(profile)

  const hostHome = input.hostHome
  const readCaps = [...profile.filesystem.hostRead]
  const writeCaps = [...profile.filesystem.hostWrite]

  for (const cap of [...readCaps, ...writeCaps]) {
    assertAbsolutePrecise(cap.path, hostHome)
  }

  for (const method of profile.credentials) {
    if (method.type === 'host-path') {
      for (const cap of method.paths) {
        assertAbsolutePrecise(cap.path, hostHome)
      }
    }
  }

  const instanceWrite = profile.filesystem.instanceReadWrite.map((kind) =>
    pathForInstanceKind(instanceDirs, kind)
  )

  const hostReads = readCaps.map((c) => canonicalize(c.path))
  const hostWrites = writeCaps
    .filter((c) => c.access === 'read-write')
    .map((c) => canonicalize(c.path))

  // Credential host-path defaults to read; read-write only when explicitly declared.
  for (const method of profile.credentials) {
    if (method.type !== 'host-path') continue
    for (const cap of method.paths) {
      const path = canonicalize(cap.path)
      hostReads.push(path)
      if (cap.access === 'read-write') hostWrites.push(path)
    }
  }

  const allowedReadRoots = dedupe([
    ...hostReads,
    ...hostWrites,
    instanceDirs.root,
    ...instanceWrite,
    ...(input.workspaceRoot ? [canonicalize(input.workspaceRoot)] : [])
  ])

  const allowedWriteRoots = dedupe([
    ...hostWrites,
    instanceDirs.root,
    ...instanceWrite,
    ...(input.workspaceRoot && input.workspaceWrite
      ? [canonicalize(input.workspaceRoot)]
      : [])
  ])

  const environment = mergeProfileEnvironment(
    profile.environment,
    instanceDirs,
    input.platform ?? process.platform
  )

  return {
    version: profile.version,
    provider: profile.provider,
    cwd: canonicalize(cwd),
    instanceRoot: instanceDirs.root,
    allowedReadRoots,
    allowedWriteRoots,
    environment,
    network: profile.network,
    process: profile.process,
    credentials: profile.credentials,
    credentialCopy: false
  }
}

/**
 * Helper: deny access when a candidate path is outside the compiled whitelist.
 * Used by contract tests (sentinel / whitelist escape).
 */
export function isPathAllowedByPolicy(
  policy: EffectivePolicyInput,
  candidate: string,
  access: 'read' | 'write'
): boolean {
  const roots = access === 'write' ? policy.allowedWriteRoots : policy.allowedReadRoots
  return roots.some((root) => isPathInsideOrEqual(candidate, root))
}

export function assertWhitelistEscapeDenied(
  policy: EffectivePolicyInput,
  candidate: string,
  access: 'read' | 'write' = 'read'
): void {
  if (isPathAllowedByPolicy(policy, candidate, access)) {
    throw new ProfileCompileError(
      `Expected whitelist escape for ${candidate}, but path was allowed`,
      'profile.compile.escape_unexpectedly_allowed'
    )
  }
}

/** Build PathCapability helpers for adapters assembling profiles. */
export function pathCapability(
  path: string,
  access: PathCapability['access'],
  purpose: PathCapability['purpose'],
  required = false
): PathCapability {
  return { path: canonicalize(path), access, purpose, required }
}
