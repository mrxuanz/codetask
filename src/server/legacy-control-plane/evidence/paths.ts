import { existsSync, readFileSync, statSync } from 'fs'
import { isAbsolute, resolve, sep } from 'path'
import { canonicalizePath } from '../../sandbox/paths'

export function normalizeChangedFilePath(
  raw: string,
  index: number,
  field = 'changedFiles'
): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error(`${field}[${index}] must be a non-empty relative path`)
  }
  if (isAbsolute(trimmed)) {
    throw new Error(`${field}[${index}] must be relative, not absolute`)
  }

  const posix = trimmed.replace(/\\/g, '/')
  if (posix.startsWith('/')) {
    throw new Error(`${field}[${index}] must be relative, not absolute`)
  }

  const segments = posix.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    throw new Error(`${field}[${index}] must be a non-empty relative path`)
  }
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`${field}[${index}] must not contain .. segments`)
  }
  if (segments.every((segment) => segment === '.')) {
    throw new Error(`${field}[${index}] must not be .`)
  }

  return segments.filter((segment) => segment !== '.').join('/')
}

export function parseChangedFilePaths(raw: unknown, options?: { required?: boolean }): string[] {
  const required = options?.required ?? true
  if (!Array.isArray(raw)) {
    if (required) throw new Error('changedFiles is required')
    return []
  }
  return raw.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`changedFiles[${index}] must be a string`)
    }
    return normalizeChangedFilePath(item, index)
  })
}

function workspaceRootPrefix(root: string): string {
  return root.endsWith(sep) ? root : `${root}${sep}`
}

export function resolveReadablePathWithinWorkspace(
  workspaceRoot: string,
  relPath: string
): string | null {
  try {
    const root = canonicalizePath(workspaceRoot)
    const absolute = resolve(root, relPath)
    const canonical = canonicalizePath(absolute)
    const prefix = workspaceRootPrefix(root)
    if (canonical !== root && !canonical.startsWith(prefix)) {
      return null
    }
    return canonical
  } catch {
    return null
  }
}

export function readWorkspaceRelativeFileExcerpt(
  workspaceRoot: string,
  relPath: string,
  maxChars: number
): string | null {
  const absolute = resolveReadablePathWithinWorkspace(workspaceRoot, relPath)
  if (!absolute || !existsSync(absolute)) return null
  try {
    const stats = statSync(absolute)
    if (!stats.isFile() || stats.size > 96_000) return null
    const raw = readFileSync(absolute, 'utf8').trim()
    if (!raw) return null
    if (raw.length <= maxChars) return raw
    return `${raw.slice(0, maxChars)}\n…(truncated)`
  } catch {
    return null
  }
}
