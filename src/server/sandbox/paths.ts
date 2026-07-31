import { realpathSync, existsSync, lstatSync } from 'fs'
import { isAbsolute, resolve, normalize, sep } from 'path'
import { processHostEnvironmentSource } from '../host-environment'
import { SandboxError } from './types'
import type { SandboxPolicy } from './types'

const DANGEROUS_WRITE_ROOTS = new Set(['/', 'C:\\', 'c:\\'])

export function canonicalizePath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new SandboxError('Path cannot be empty', 'sandbox.path.empty')
  }
  if (!isAbsolute(trimmed) || trimmed.split(/[\\/]+/).includes('..')) {
    throw new SandboxError(
      `Relative path or path containing .. is not allowed: ${input}`,
      'sandbox.path.relative'
    )
  }

  const normalized = normalize(resolve(trimmed))
  if (!existsSync(normalized)) {
    const parent = resolve(normalized, '..')
    if (!existsSync(parent)) {
      throw new SandboxError(
        `Path does not exist and parent cannot be canonicalized: ${input}`,
        'sandbox.path.missing'
      )
    }
    try {
      const parentReal = realpathSync(parent)
      const base = normalized.split(sep).pop() ?? ''
      return resolve(parentReal, base)
    } catch (error) {
      throw new SandboxError(
        `canonicalize failed: ${input} (${error instanceof Error ? error.message : String(error)})`,
        'sandbox.path.canonicalize'
      )
    }
  }

  try {
    return realpathSync(normalized)
  } catch (error) {
    throw new SandboxError(
      `realpath failed: ${input} (${error instanceof Error ? error.message : String(error)})`,
      'sandbox.path.realpath'
    )
  }
}

function assertSafeWriteRoot(path: string): void {
  const lower = path.toLowerCase()
  if (DANGEROUS_WRITE_ROOTS.has(path) || DANGEROUS_WRITE_ROOTS.has(lower)) {
    throw new SandboxError(
      `Root directory cannot be used as a writable root: ${path}`,
      'sandbox.policy.dangerous_write_root'
    )
  }
  const hostEnv = processHostEnvironmentSource.snapshot()
  const home = hostEnv.HOME ?? hostEnv.USERPROFILE
  if (home) {
    const homeCanon = canonicalizePath(home)
    if (path === homeCanon) {
      throw new SandboxError(
        `User HOME cannot be used as a writable root: ${path}`,
        'sandbox.policy.home_write'
      )
    }
  }
}

function assertNoSymlinkEscape(rulePath: string, allowedRoot: string): void {
  if (!existsSync(rulePath)) return
  const stat = lstatSync(rulePath)
  if (!stat.isSymbolicLink()) return

  const target = realpathSync(rulePath)
  const root = realpathSync(allowedRoot)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (target !== root && !target.startsWith(prefix)) {
    throw new SandboxError(
      `Writable rule escapes allowed root via symlink: ${rulePath} -> ${target}`,
      'sandbox.policy.symlink_escape'
    )
  }
}

function dedupRoots(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

export function compileSandboxPolicy(policy: SandboxPolicy): SandboxPolicy {
  const cwd = canonicalizePath(policy.cwd)
  const scratchRoot = canonicalizePath(policy.scratchRoot)

  const allowedReadRoots = dedupRoots(
    policy.filesystem.allowedReadRoots.map((root) => canonicalizePath(root))
  )
  const allowedWriteRoots = dedupRoots(
    policy.filesystem.allowedWriteRoots.map((root) => {
      const path = canonicalizePath(root)
      assertSafeWriteRoot(path)
      assertNoSymlinkEscape(path, path)
      return path
    })
  )

  if (policy.filesystem.defaultAccess !== 'none') {
    throw new SandboxError(
      `Sandbox requires defaultAccess=none, current: ${policy.filesystem.defaultAccess}`,
      'sandbox.policy.default_access'
    )
  }

  return {
    ...policy,
    cwd,
    scratchRoot,
    filesystem: {
      ...policy.filesystem,
      allowedReadRoots,
      allowedWriteRoots
    }
  }
}

export function protectedMetadataPaths(workspaceRoot: string, names: string[]): string[] {
  return names.map((name) => resolve(workspaceRoot, name))
}
