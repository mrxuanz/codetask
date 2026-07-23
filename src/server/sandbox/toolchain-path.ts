import { constants, accessSync, existsSync, realpathSync, statSync } from 'fs'
import { basename, delimiter, dirname, join, normalize } from 'path'
import { processHostEnvironmentSource } from '../host-environment'

interface ToolchainPathOptions {
  env?: Record<string, string | undefined>
  execPath?: string
  hostHome?: string
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

/**
 * Resolve only host directories that contain an executable Node entry point.
 * This deliberately avoids importing an interactive shell profile or exposing
 * the whole host home to sandboxed providers.
 */
export function resolveHostNodeBinDirs(options: ToolchainPathOptions = {}): string[] {
  const env = options.env ?? processHostEnvironmentSource.snapshot()
  const platform = options.platform ?? process.platform
  const execPath = options.execPath ?? process.execPath
  const hostHome = options.hostHome ?? env.HOME?.trim() ?? env.USERPROFILE?.trim() ?? ''
  const candidates = [
    execPath,
    env.VOLTA_HOME ? join(env.VOLTA_HOME, 'bin') : undefined,
    hostHome ? join(hostHome, '.volta', 'bin') : undefined,
    env.NVM_SYMLINK
  ]

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
