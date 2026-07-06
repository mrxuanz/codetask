import { realpathSync, existsSync, lstatSync } from 'fs'
import { resolve, normalize, sep } from 'path'
import { SandboxError } from './types'
import type { FileRule, AnySandboxPolicy, SandboxPolicy, SandboxPolicyV2 } from './types'

const DANGEROUS_WRITE_ROOTS = new Set(['/', 'C:\\', 'c:\\'])

export function canonicalizePath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new SandboxError('Path cannot be empty', 'sandbox.path.empty')
  }
  if (trimmed.includes('..')) {
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
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home) {
    const homeCanon = canonicalizePath(home)
    if (path === homeCanon && !path.includes('runtime')) {
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

function compileV1Policy(policy: SandboxPolicy): SandboxPolicy {
  const cwd = canonicalizePath(policy.cwd)
  const runtimeRoot = canonicalizePath(policy.runtimeRoot)

  const rules: FileRule[] = policy.filesystem.rules.map((rule) => {
    const path = canonicalizePath(rule.path)
    if (rule.access === 'write') {
      assertSafeWriteRoot(path)
    }
    return { ...rule, path }
  })

  for (const rule of rules) {
    if (rule.access === 'write') {
      assertNoSymlinkEscape(rule.path, rule.path)
    }
  }

  const writeRules = rules.filter((r) => r.access === 'write')
  for (const rule of rules) {
    if (rule.access !== 'none') continue
    const covered = writeRules.some((w) =>
      rule.path.startsWith(w.path.endsWith(sep) ? w.path : `${w.path}${sep}`)
    )
    if (covered) {
      throw new SandboxError(
        `none rule shadowed by wider write rule: ${rule.path}`,
        'sandbox.policy.none_shadowed'
      )
    }
  }

  return {
    ...policy,
    cwd,
    runtimeRoot,
    filesystem: {
      ...policy.filesystem,
      rules
    }
  }
}

function compileV2Policy(policy: SandboxPolicyV2): SandboxPolicyV2 {
  const cwd = canonicalizePath(policy.cwd)
  const runtimeRoot = canonicalizePath(policy.runtimeRoot)

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
      `V2 sandbox requires defaultAccess=none, current: ${policy.filesystem.defaultAccess}`,
      'sandbox.policy.v2_default_access'
    )
  }

  return {
    ...policy,
    cwd,
    runtimeRoot,
    filesystem: {
      ...policy.filesystem,
      allowedReadRoots,
      allowedWriteRoots
    }
  }
}

export function compileSandboxPolicy(policy: AnySandboxPolicy): AnySandboxPolicy {
  if (policy.version === 2) {
    return compileV2Policy(policy)
  }
  return compileV1Policy(policy)
}

export function protectedMetadataPaths(workspaceRoot: string, names: string[]): string[] {
  return names.map((name) => resolve(workspaceRoot, name))
}
