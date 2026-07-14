import { resolve } from 'path'
import type { AgentRole, AnySandboxPolicy, SandboxPolicyV2 } from './types'
import { compileSandboxPolicy, canonicalizePath } from './paths'

const PROTECTED_NAMES = ['.agents', '.codex', '.codeteam'] as const

function mergeUniqueRoots(existing: string[], extra: string[]): string[] {
  const seen = new Set(existing.map((path) => path.toLowerCase()))
  const merged = [...existing]
  for (const root of extra) {
    const trimmed = root.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(trimmed)
  }
  return merged
}

function isSandboxPolicyV2(policy: AnySandboxPolicy): policy is SandboxPolicyV2 {
  return policy.version === 2
}

export function policyForRole(input: {
  role: AgentRole
  workspaceRoot: string
  runtimeRoot: string
  verifierOutputRoot?: string
}): SandboxPolicyV2 {
  const workspaceRoot = resolve(input.workspaceRoot)
  const runtimeRoot = resolve(input.runtimeRoot)

  const allowedReadRoots = [workspaceRoot, runtimeRoot]
  const allowedWriteRoots = [runtimeRoot]

  // FIX-PLAN §1.1 / §10.1: ordinary chat may perform simple workspace edits under outer sandbox
  // (protected by workspace_leases). Planner must not write project source; only runtime artifacts.
  if (input.role === 'task-worker' || input.role === 'conversation') {
    allowedWriteRoots.push(workspaceRoot)
  }

  if (
    (input.role === 'milestone-verifier' || input.role === 'slice-verifier') &&
    input.verifierOutputRoot
  ) {
    allowedWriteRoots.push(resolve(input.verifierOutputRoot))
  }

  const base: SandboxPolicyV2 = {
    version: 2,
    role: input.role,
    cwd: workspaceRoot,
    runtimeRoot,
    filesystem: {
      defaultAccess: 'none',
      allowedReadRoots,
      allowedWriteRoots,
      protectedNames: [...PROTECTED_NAMES],
      allowSystemRuntime: true
    },
    network: {
      mode: 'none',
      allowLoopback: true,
      allowUnixSockets: []
    },
    process: {
      isolateFromHost: true,
      allowOwnDescendantSignals: true,
      denyPtrace: true
    }
  }

  return compileSandboxPolicy(base) as SandboxPolicyV2
}

export function applyProviderWriteRoots(
  policy: AnySandboxPolicy,
  writeRoots: string[] | undefined
): AnySandboxPolicy {
  if (!writeRoots?.length) return policy

  if (isSandboxPolicyV2(policy)) {
    const merged = mergeUniqueRoots(policy.filesystem.allowedWriteRoots, writeRoots)
    if (merged.length === policy.filesystem.allowedWriteRoots.length) return policy
    return compileSandboxPolicy({
      ...policy,
      filesystem: {
        ...policy.filesystem,
        allowedWriteRoots: merged
      }
    })
  }

  const existingWrite = new Set(
    policy.filesystem.rules
      .filter((rule) => rule.access === 'write')
      .map((rule) => rule.path.toLowerCase())
  )

  const extraRules = writeRoots
    .map((root) => root.trim())
    .filter((trimmed) => trimmed && !existingWrite.has(trimmed.toLowerCase()))
    .map((path) => ({ path, access: 'write' as const }))

  if (extraRules.length === 0) return policy

  return compileSandboxPolicy({
    ...policy,
    filesystem: {
      ...policy.filesystem,
      rules: [...policy.filesystem.rules, ...extraRules]
    }
  })
}

export function applyProviderReadRoots(
  policy: AnySandboxPolicy,
  readRoots: string[] | undefined
): AnySandboxPolicy {
  if (!readRoots?.length) return policy

  if (!isSandboxPolicyV2(policy)) return policy

  const merged = mergeUniqueRoots(policy.filesystem.allowedReadRoots, readRoots)
  if (merged.length === policy.filesystem.allowedReadRoots.length) return policy

  return compileSandboxPolicy({
    ...policy,
    filesystem: {
      ...policy.filesystem,
      allowedReadRoots: merged
    }
  })
}

export function collectPolicyWriteRoots(policy: AnySandboxPolicy): string[] {
  if (isSandboxPolicyV2(policy)) {
    return [...policy.filesystem.allowedWriteRoots]
  }

  const seen = new Set<string>()
  const roots: string[] = []

  const add = (path: string): void => {
    const trimmed = path.trim()
    if (!trimmed) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    roots.push(trimmed)
  }

  for (const rule of policy.filesystem.rules) {
    if (rule.access === 'write') add(rule.path)
  }

  if (policy.role === 'task-worker') {
    add(policy.cwd)
  }

  return roots
}

export function collectPolicyReadRoots(policy: AnySandboxPolicy): string[] {
  if (isSandboxPolicyV2(policy)) {
    return [...policy.filesystem.allowedReadRoots]
  }
  return []
}

export function policyForRoleV2(input: {
  role: AgentRole
  workspaceRoot: string
  runtimeRoot: string
  verifierOutputRoot?: string
  providerReadRoots?: string[]
  providerWriteRoots?: string[]
  attachmentReadRoots?: string[]
}): SandboxPolicyV2 {
  const workspaceRoot = resolve(input.workspaceRoot)
  const runtimeRoot = resolve(input.runtimeRoot)

  const allowedReadRoots = [
    workspaceRoot,
    runtimeRoot,
    ...(input.providerReadRoots ?? []),
    ...(input.attachmentReadRoots ?? [])
  ].map((root) => canonicalizePath(root))

  const allowedWriteRoots: string[] = [runtimeRoot]

  if (input.role === 'task-worker') {
    allowedWriteRoots.push(workspaceRoot)
  }

  if (
    (input.role === 'milestone-verifier' || input.role === 'slice-verifier') &&
    input.verifierOutputRoot
  ) {
    allowedWriteRoots.push(resolve(input.verifierOutputRoot))
  }

  if (input.providerWriteRoots?.length) {
    allowedWriteRoots.push(...input.providerWriteRoots)
  }

  const uniqueRead = mergeUniqueRoots([], allowedReadRoots)

  return compileSandboxPolicy({
    version: 2,
    role: input.role,
    cwd: canonicalizePath(workspaceRoot),
    runtimeRoot: canonicalizePath(runtimeRoot),
    filesystem: {
      defaultAccess: 'none',
      allowedReadRoots: uniqueRead,
      allowedWriteRoots: allowedWriteRoots.map((root) => canonicalizePath(root)),
      protectedNames: [...PROTECTED_NAMES, '.git'],
      allowSystemRuntime: true
    },
    network: {
      mode: 'none',
      allowLoopback: true,
      allowUnixSockets: []
    },
    process: {
      isolateFromHost: true,
      allowOwnDescendantSignals: true,
      denyPtrace: true
    }
  }) as SandboxPolicyV2
}

export function collectPolicyWriteRootsV2(policy: SandboxPolicyV2): string[] {
  return [...policy.filesystem.allowedWriteRoots]
}

export function isTaskRole(role: AgentRole): boolean {
  return role === 'task-worker'
}

export function roleAllowsShell(role: AgentRole): boolean {
  return role === 'task-worker' || role === 'milestone-verifier' || role === 'slice-verifier'
}
