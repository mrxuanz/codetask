/**
 * Fail-closed loader for the packaged codeteam-sandbox Node-API `.node`.
 * Never searches PATH; only resolves packaged / explicit addon directories.
 *
 * @see 重构.md §10.1–10.2
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRequire = createRequire(
  typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url)
)

export class NativeLoadError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'runtime.native.missing'
      | 'runtime.native.abi_mismatch'
      | 'runtime.native.hash_mismatch'
      | 'runtime.native.load_failed'
      | 'runtime.native.unsupported_platform'
  ) {
    super(message)
    this.name = 'NativeLoadError'
  }
}

export interface NodeLoaderOptions {
  /** Override addon directory (must contain index.js + platform .node). */
  readonly addonDir?: string
  /** When set, SHA-256 of the `.node` file must match (hex, case-insensitive). */
  readonly expectedSha256?: string
  /** When set, must equal `process.versions.modules`. */
  readonly expectedModulesAbi?: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Inject require for tests. */
  readonly requireFn?: (id: string) => unknown
}

export interface LoadedNativeBinding {
  readonly addonDir: string
  readonly nodePath: string
  readonly sha256: string
  readonly modulesAbi: string
  readonly binding: CodeteamSandboxNativeApi
}

/** Minimal surface the Runtime Adapter needs from the NAPI addon. */
export interface CodeteamSandboxNativeApi {
  preflight(): void
  launchSandboxedWorker(options: {
    policyJson: string
    command: string
    args: string[]
    cwd: string
    env?: Array<{ key: string; value: string }>
    readRoots?: string[]
    writeRoots?: string[]
  }): unknown
  helperVersion?: () => string
  resolveHelperPath?: () => string
}

function isMusl(env: NodeJS.ProcessEnv): boolean {
  if (env.CODETEAM_SANDBOX_FORCE_MUSL === '1') return true
  try {
    // Node report is the reliable path; fall back to false (gnu) if unavailable.
    const report = (
      process as NodeJS.Process & {
        report?: { getReport?: () => object }
      }
    ).report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined
    return !report?.header?.glibcVersionRuntime
  } catch {
    return false
  }
}

/**
 * Platform triple file name for the packaged binding (mirrors native/codeteam-sandbox/index.js).
 */
export function resolveNodeBindingFileName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env
): string {
  switch (platform) {
    case 'linux': {
      const libc = isMusl(env) ? 'musl' : 'gnu'
      if (arch === 'x64') return `codeteam-sandbox.linux-x64-${libc}.node`
      if (arch === 'arm64') return `codeteam-sandbox.linux-arm64-${libc}.node`
      break
    }
    case 'darwin':
      if (arch === 'arm64') return 'codeteam-sandbox.darwin-arm64.node'
      if (arch === 'x64') return 'codeteam-sandbox.darwin-x64.node'
      break
    case 'win32':
      if (arch === 'x64') return 'codeteam-sandbox.win32-x64-msvc.node'
      if (arch === 'arm64') return 'codeteam-sandbox.win32-arm64-msvc.node'
      break
    default:
      break
  }
  throw new NativeLoadError(
    `Unsupported platform for sandbox .node: ${platform}/${arch}`,
    'runtime.native.unsupported_platform'
  )
}

function candidateAddonDirs(options: NodeLoaderOptions): string[] {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const dirs: string[] = []

  // Explicit override is exclusive — never fall through to packaged defaults.
  if (options.addonDir?.trim()) {
    return [options.addonDir.trim()]
  }

  const fromEnv = env.CODETEAM_SANDBOX_NATIVE?.trim()
  if (fromEnv) dirs.push(fromEnv)

  // Repo / packaged layout relative to this adapter file.
  const here =
    typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))
  dirs.push(join(here, '..', '..', '..', '..', 'native', 'codeteam-sandbox'))
  dirs.push(join(cwd, 'native', 'codeteam-sandbox'))

  return dirs
}

export function resolveAddonDir(options: NodeLoaderOptions = {}): string {
  for (const dir of candidateAddonDirs(options)) {
    if (existsSync(join(dir, 'index.js'))) return dir
  }
  throw new NativeLoadError(
    'Sandbox native addon directory not found (fail closed; not searching PATH)',
    'runtime.native.missing'
  )
}

export function resolveNodePath(options: NodeLoaderOptions = {}): {
  addonDir: string
  nodePath: string
} {
  const addonDir = resolveAddonDir(options)
  const fileName = resolveNodeBindingFileName(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
    options.env ?? process.env
  )
  const nodePath = join(addonDir, fileName)
  if (!existsSync(nodePath)) {
    throw new NativeLoadError(
      `Sandbox .node missing at ${nodePath} (fail closed)`,
      'runtime.native.missing'
    )
  }
  return { addonDir, nodePath }
}

export function hashFileSha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

export function assertModulesAbi(
  expected: string | undefined,
  actual: string = process.versions.modules
): void {
  if (expected == null || expected === '') return
  if (expected !== actual) {
    throw new NativeLoadError(
      `Sandbox .node ABI mismatch: expected modules=${expected}, got ${actual}`,
      'runtime.native.abi_mismatch'
    )
  }
}

export function assertNodeHash(nodePath: string, expectedSha256: string | undefined): string {
  const sha256 = hashFileSha256(nodePath)
  if (expectedSha256 != null && expectedSha256 !== '') {
    if (sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new NativeLoadError(
        `Sandbox .node hash mismatch for ${nodePath}`,
        'runtime.native.hash_mismatch'
      )
    }
  }
  return sha256
}

/**
 * Load the packaged `.node` with ABI + optional integrity checks.
 * Fail closed: missing file, ABI mismatch, or hash mismatch throw NativeLoadError.
 */
export function loadNativeNode(options: NodeLoaderOptions = {}): LoadedNativeBinding {
  assertModulesAbi(options.expectedModulesAbi)
  const { addonDir, nodePath } = resolveNodePath(options)
  const sha256 = assertNodeHash(nodePath, options.expectedSha256)

  const requireFn = options.requireFn ?? defaultRequire
  try {
    const binding = requireFn(join(addonDir, 'index.js')) as CodeteamSandboxNativeApi
    if (
      typeof binding?.preflight !== 'function' ||
      typeof binding?.launchSandboxedWorker !== 'function'
    ) {
      throw new NativeLoadError(
        'Sandbox native binding missing required exports',
        'runtime.native.load_failed'
      )
    }
    return {
      addonDir,
      nodePath,
      sha256,
      modulesAbi: process.versions.modules,
      binding
    }
  } catch (error) {
    if (error instanceof NativeLoadError) throw error
    throw new NativeLoadError(
      `Failed to load sandbox .node: ${error instanceof Error ? error.message : String(error)}`,
      'runtime.native.load_failed'
    )
  }
}
