import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { AppError } from '../error'
import { processHostEnvironmentSource } from '../host-environment'

export interface BrowseEntry {
  name: string
  path: string
}

export interface BrowseResult {
  parentPath: string
  entries: BrowseEntry[]
}

function userHome(): string {
  const home = processHostEnvironmentSource.snapshot().USERPROFILE || homedir()
  if (!home) {
    throw AppError.internal('Unable to resolve user home directory', 'project.home_not_found')
  }
  return home
}

export function cleanDisplayPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  }
  if (path.startsWith('\\\\?\\')) {
    return path.slice('\\\\?\\'.length)
  }
  return path
}

function displayPathString(path: string): string {
  return cleanDisplayPath(path)
}

function expandTilde(input: string): string {
  const trimmed = displayPathString(input.trim())
  if (trimmed === '~') {
    return userHome()
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(userHome(), trimmed.slice(2))
  }
  return trimmed
}

function isRootPath(path: string): boolean {
  return path === '/' || path === '\\' || /^[a-zA-Z]:\\?$/.test(path)
}

function trimTrailingSeparators(path: string): string {
  if (isRootPath(path)) return path
  let result = path
  while (result.length > 1 && /[\\/]$/.test(result)) {
    result = result.replace(/[\\/]+$/, '')
  }
  return result || path
}

export function normalizeWorkspacePath(input: string, createIfMissing: boolean): string {
  const expanded = expandTilde(input)
  const absolute = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)

  let canonical: string
  if (existsSync(absolute)) {
    try {
      canonical = realpathSync.native(absolute)
    } catch (cause) {
      throw AppError.badRequest(
        `Path does not exist or is inaccessible: ${cause instanceof Error ? cause.message : String(cause)}`,
        'project.path_inaccessible',
        { path: displayPathString(absolute) }
      )
    }
  } else if (createIfMissing) {
    try {
      mkdirSync(absolute, { recursive: true })
      canonical = realpathSync.native(absolute)
    } catch (cause) {
      throw AppError.badRequest(
        `Unable to create directory: ${cause instanceof Error ? cause.message : String(cause)}`,
        'project.path_inaccessible',
        { path: displayPathString(absolute) }
      )
    }
  } else {
    throw AppError.badRequest(
      `Path does not exist: ${displayPathString(absolute)}`,
      'project.path_not_found',
      { path: displayPathString(absolute) }
    )
  }

  return displayPathString(canonical)
}

export function inferTitleFromPath(workspaceRoot: string): string {
  const normalized = workspaceRoot.replace(/[\\/]+$/, '')
  const last = basename(normalized)
  return last.trim() || 'Untitled'
}

function resolveExistingDirectory(path: string): string {
  if (!existsSync(path)) {
    throw AppError.badRequest(
      `Directory does not exist: ${displayPathString(path)}`,
      'project.directory_not_found',
      { path: displayPathString(path) }
    )
  }
  try {
    const stats = statSync(path)
    if (!stats.isDirectory()) {
      throw AppError.badRequest(
        `Not a directory: ${displayPathString(path)}`,
        'project.not_a_directory',
        { path: displayPathString(path) }
      )
    }
    return displayPathString(realpathSync.native(path))
  } catch (cause) {
    if (cause instanceof AppError) throw cause
    throw AppError.badRequest(
      `Unable to read directory ${displayPathString(path)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'project.path_inaccessible',
      { path: displayPathString(path) }
    )
  }
}

export function browse(partialPath: string): BrowseResult {
  const trimmed = partialPath.trim()
  const query = trimmed ? expandTilde(trimmed) : userHome()
  const endsWithSeparator = /[\\/]$/.test(trimmed) || trimmed === '~'

  let parentPath: string
  let prefix: string

  if (endsWithSeparator) {
    parentPath = query
    prefix = ''
  } else {
    parentPath = dirname(query)
    prefix = basename(query)
    if (!parentPath || parentPath === '.') {
      parentPath = query
      prefix = ''
    }
  }

  let resolvedParent: string
  try {
    resolvedParent = resolveExistingDirectory(parentPath)
  } catch {
    const fallback = dirname(parentPath)
    if (!fallback || fallback === parentPath) {
      throw AppError.badRequest('Unable to browse this path', 'project.path_inaccessible', {
        path: displayPathString(parentPath)
      })
    }
    resolvedParent = resolveExistingDirectory(fallback)
  }

  const showHidden = endsWithSeparator || prefix.startsWith('.')
  const prefixLower = prefix.toLowerCase()

  const entries: BrowseEntry[] = []
  try {
    const dirents = readdirSync(resolvedParent, { withFileTypes: true })
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue
      const name = dirent.name
      if (!name) continue
      if (!showHidden && name.startsWith('.')) continue
      if (prefixLower && !name.toLowerCase().startsWith(prefixLower)) continue
      entries.push({
        name,
        path: displayPathString(join(resolvedParent, name))
      })
    }
  } catch (cause) {
    throw AppError.badRequest(
      `Unable to read directory ${displayPathString(resolvedParent)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'project.path_inaccessible',
      { path: displayPathString(resolvedParent) }
    )
  }

  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))

  return {
    parentPath: resolvedParent,
    entries
  }
}

export function parentBrowsePath(path: string): string {
  const expanded = expandTilde(path)
  const trimmed = trimTrailingSeparators(expanded)
  const parent = dirname(trimmed)
  if (!parent || parent === trimmed) {
    throw AppError.badRequest('Already at root directory', 'project.already_root')
  }
  return resolveExistingDirectory(trimTrailingSeparators(parent))
}
