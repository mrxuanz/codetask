import { constants, accessSync, existsSync, realpathSync, statSync } from 'fs'
import { basename, delimiter, dirname, join, normalize, parse } from 'path'
import { processHostEnvironmentSource } from '../host-environment'

interface ToolchainPathOptions {
  env?: Record<string, string | undefined>
  execPath?: string
  platform?: NodeJS.Platform
}

function isExecutableFile(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function nodeExecutableNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['node.exe', 'node.cmd', 'node.bat', 'node'] : ['node']
}

function directoryContainsNode(dir: string, platform: NodeJS.Platform): boolean {
  return nodeExecutableNames(platform).some((name) => isExecutableFile(join(dir, name)))
}

function directoryForNodeCandidate(
  candidate: string | null | undefined,
  platform: NodeJS.Platform
): string | null {
  const clean = candidate?.trim().replace(/^"|"$/g, '')
  if (!clean || !existsSync(clean)) return null
  try {
    if (statSync(clean).isDirectory()) {
      return directoryContainsNode(clean, platform) ? clean : null
    }
    return isExecutableFile(clean) && /^node(?:\.exe|\.cmd|\.bat)?$/i.test(basename(clean))
      ? dirname(clean)
      : null
  } catch {
    return null
  }
}

function canonicalDirectory(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return normalize(path)
    }
  }
}

function pathValue(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== 'win32') return env.PATH
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === 'path')
  return key ? env[key] : undefined
}

function pathEntries(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): string[] {
  const separator = platform === 'win32' ? ';' : ':'
  return (pathValue(env, platform) ?? '')
    .split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
}

/**
 * Generic manager/toolchain root derived from conventional executable-entry
 * directories. No version-manager name or user-home layout is assumed.
 */
export function resolveToolchainContainerRoot(directory: string): string | null {
  const normalized = normalize(directory)
  const leaf = basename(normalized).toLowerCase()
  if (leaf !== 'bin' && leaf !== 'shims') return null
  const parent = dirname(normalized)
  return parent === normalized || parent === parse(normalized).root ? null : parent
}

/**
 * Resolve only host directories that contain an executable Node entry point.
 * The host environment has already been hydrated at runtime startup, so this
 * only consumes standard PATH entries and the executable that launched CodeTask.
 */
export function resolveHostNodeBinDirs(options: ToolchainPathOptions = {}): string[] {
  const env = options.env ?? processHostEnvironmentSource.snapshot()
  const platform = options.platform ?? process.platform
  const execPath = options.execPath ?? process.execPath
  const candidates = [execPath, ...pathEntries(env, platform)]

  const seen = new Set<string>()
  const directories: string[] = []
  for (const candidate of candidates) {
    const directory = directoryForNodeCandidate(candidate, platform)
    if (!directory) continue
    const canonical = canonicalDirectory(directory)
    const key = platform === 'win32' ? canonical.toLowerCase() : canonical
    if (seen.has(key)) continue
    seen.add(key)
    directories.push(canonical)
  }
  return directories
}

export function augmentPathWithHostNode(
  pathValue: string | null | undefined,
  options: ToolchainPathOptions = {}
): string {
  const platform = options.platform ?? process.platform
  const separator = platform === process.platform ? delimiter : platform === 'win32' ? ';' : ':'
  const entries = [
    ...resolveHostNodeBinDirs(options),
    ...(pathValue ?? '')
      .split(separator)
      .map((entry) => entry.trim())
      .filter(Boolean)
  ]
  const seen = new Set<string>()
  const unique: string[] = []
  for (const entry of entries) {
    const canonical = canonicalDirectory(entry)
    const key = platform === 'win32' ? canonical.toLowerCase() : canonical
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(entry)
  }
  return unique.join(separator)
}
