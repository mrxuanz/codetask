import { existsSync, realpathSync } from 'fs'
import { delimiter, resolve, sep } from 'path'
import { getAppContext } from '../bootstrap'
import { AppError } from '../error'
import { cleanDisplayPath } from './index'

let cachedRoots: string[] | null | undefined

function parseAllowedRootsEnv(): string[] | null {
  const raw = process.env.CODETASK_ALLOWED_WORKSPACE_ROOTS?.trim()
  if (!raw) return null

  const roots: string[] = []
  const seen = new Set<string>()

  for (const entry of raw.split(delimiter)) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    let canonical: string
    try {
      const absolute = resolve(trimmed)
      canonical = existsSync(absolute) ? realpathSync.native(absolute) : absolute
    } catch {
      throw AppError.badRequest(
        `Invalid allowed workspace root: ${trimmed}`,
        'project.allowed_root_invalid',
        { path: trimmed }
      )
    }
    const key = canonical.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(cleanDisplayPath(canonical))
  }

  if (roots.length === 0) {
    throw AppError.internal(
      'CODETASK_ALLOWED_WORKSPACE_ROOTS is set but empty',
      'project.allowed_roots_missing'
    )
  }

  return roots
}

export function getAllowedWorkspaceRoots(): string[] | null {
  if (cachedRoots !== undefined) return cachedRoots
  cachedRoots = parseAllowedRootsEnv()
  return cachedRoots
}

export function resetAllowedWorkspaceRootsCacheForTests(): void {
  cachedRoots = undefined
}

export function isServerWorkspaceRootPolicyEnabled(): boolean {
  try {
    return getAppContext().security.mode === 'server'
  } catch {
    return process.env.CODETASK_MODE === 'server'
  }
}

export function assertWorkspacePathAllowed(workspaceRoot: string): void {
  if (!isServerWorkspaceRootPolicyEnabled()) return

  const allowedRoots = getAllowedWorkspaceRoots()
  if (!allowedRoots?.length) {
    throw new AppError(
      40301,
      'Server mode requires CODETASK_ALLOWED_WORKSPACE_ROOTS',
      {
        error: 'Server mode requires CODETASK_ALLOWED_WORKSPACE_ROOTS',
        turnErrorCode: 'project.allowed_roots_missing'
      },
      403
    )
  }

  let canonical: string
  try {
    canonical = realpathSync.native(resolve(workspaceRoot))
  } catch {
    throw AppError.badRequest(
      'Workspace path is inaccessible',
      'project.path_inaccessible',
      { path: cleanDisplayPath(workspaceRoot) }
    )
  }

  const normalized = cleanDisplayPath(canonical)
  const allowed = allowedRoots.some((root) => pathWithinRoot(normalized, root))
  if (!allowed) {
    throw new AppError(
      40301,
      'Workspace path is outside allowed roots',
      {
        error: 'Workspace path is outside allowed roots',
        turnErrorCode: 'project.workspace_not_allowed',
        path: normalized
      },
      403
    )
  }
}

export function pathWithinRoot(candidate: string, root: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate === root || candidate.startsWith(normalizedRoot)
}
